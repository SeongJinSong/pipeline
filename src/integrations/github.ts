import { Octokit } from "@octokit/rest";
import sodium from "libsodium-wrappers";
import { exec } from "../util/exec.js";

export interface ProjectRef {
  id: string;
  url: string;
}

export class GitHub {
  readonly octokit: Octokit;
  /** GitHub Projects(v2) 용. 개인 계정 Project 는 fine-grained PAT 로 못 만들어서 classic PAT(project 권한)를 따로 받는다 */
  readonly projectOctokit: Octokit;
  private ownerIsOrg: boolean | undefined;

  constructor(
    private token: string,
    readonly owner: string,
    projectToken?: string,
  ) {
    this.octokit = new Octokit({ auth: token });
    this.projectOctokit = projectToken ? new Octokit({ auth: projectToken }) : this.octokit;
  }

  private async isOrg(): Promise<boolean> {
    if (this.ownerIsOrg === undefined) {
      const { data } = await this.octokit.users.getByUsername({ username: this.owner });
      this.ownerIsOrg = data.type === "Organization";
    }
    return this.ownerIsOrg;
  }

  async createRepo(name: string, description: string, isPrivate: boolean): Promise<string> {
    const params = { name, description, private: isPrivate, auto_init: false };
    const { data } = (await this.isOrg())
      ? await this.octokit.repos.createInOrg({ org: this.owner, ...params })
      : await this.octokit.repos.createForAuthenticatedUser(params);
    return data.full_name;
  }

  /** 토큰이 들어간 clone URL. 로그에 남기지 말 것 (exec의 redact로 가린다). */
  authedUrl(fullName: string): string {
    return `https://x-access-token:${this.token}@github.com/${fullName}.git`;
  }

  /** 레포 정보 (없거나 권한이 없으면 404/403 오류) */
  async getRepo(fullName: string): Promise<{ fullName: string; name: string; description: string; defaultBranch: string }> {
    const [owner, repo] = fullName.split("/");
    const { data } = await this.octokit.repos.get({ owner, repo });
    return {
      fullName: data.full_name,
      name: data.name,
      description: data.description ?? "",
      defaultBranch: data.default_branch,
    };
  }

  async clone(fullName: string, dir: string, branch?: string): Promise<void> {
    const args = ["clone", "--depth", "50"];
    if (branch) args.push("--branch", branch);
    args.push(this.authedUrl(fullName), dir);
    await exec("git", args, { redact: [this.token] });
    await configureGitIdentity(dir);
  }

  async push(dir: string, branch: string): Promise<void> {
    await exec("git", ["push", "-u", "origin", branch], { cwd: dir, redact: [this.token] });
  }

  /** 라벨이 없으면 만든다 (이미 있으면 그대로) */
  async ensureLabel(fullName: string, name: string, color: string, description: string): Promise<void> {
    const [owner, repo] = fullName.split("/");
    try {
      await this.octokit.issues.createLabel({ owner, repo, name, color, description });
    } catch (err) {
      if ((err as { status?: number }).status !== 422) throw err; // 422 = already_exists
    }
  }

  async createIssue(fullName: string, title: string, body: string, labels: string[] = []): Promise<number> {
    const [owner, repo] = fullName.split("/");
    const { data } = await this.octokit.issues.create({ owner, repo, title, body, labels });
    return data.number;
  }

  async commentIssue(fullName: string, issueNumber: number, body: string): Promise<void> {
    const [owner, repo] = fullName.split("/");
    await this.octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }

  async closeIssue(fullName: string, issueNumber: number, reason: "completed" | "not_planned"): Promise<void> {
    const [owner, repo] = fullName.split("/");
    await this.octokit.issues.update({ owner, repo, issue_number: issueNumber, state: "closed", state_reason: reason });
  }

  /**
   * 레포에 연결된 GitHub Project(v2) 보드를 만든다.
   * 새 Project 는 기본 워크플로(항목 닫힘·PR 병합 → Done)가 켜져 있어 머지하면 Done 으로 간다.
   */
  async createProject(fullName: string, title: string): Promise<ProjectRef> {
    const [owner, name] = fullName.split("/");
    const ids = await this.projectOctokit.graphql<{ repositoryOwner: { id: string }; repository: { id: string } }>(
      `query($owner: String!, $name: String!) { repositoryOwner(login: $owner) { id } repository(owner: $owner, name: $name) { id } }`,
      { owner, name },
    );
    const { createProjectV2 } = await this.projectOctokit.graphql<{ createProjectV2: { projectV2: ProjectRef } }>(
      `mutation($ownerId: ID!, $repositoryId: ID!, $title: String!) {
        createProjectV2(input: { ownerId: $ownerId, repositoryId: $repositoryId, title: $title }) { projectV2 { id url } }
      }`,
      { ownerId: ids.repositoryOwner.id, repositoryId: ids.repository.id, title },
    );
    return createProjectV2.projectV2;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.projectOctokit.graphql(`mutation($id: ID!) { deleteProjectV2(input: { projectId: $id }) { clientMutationId } }`, {
      id: projectId,
    });
  }

  /** 이슈나 PR 을 Project 에 넣고, status 를 주면 Status 칸(Todo/In Progress/Done)을 맞춘다 */
  async addToProject(projectId: string, fullName: string, number: number, status?: string): Promise<void> {
    const [owner, name] = fullName.split("/");
    const { repository } = await this.projectOctokit.graphql<{ repository: { issueOrPullRequest: { id: string } } }>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { ... on Issue { id } ... on PullRequest { id } } }
      }`,
      { owner, name, number },
    );
    const { addProjectV2ItemById } = await this.projectOctokit.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } } }`,
      { projectId, contentId: repository.issueOrPullRequest.id },
    );
    if (status) await this.setProjectStatus(projectId, addProjectV2ItemById.item.id, status);
  }

  private async setProjectStatus(projectId: string, itemId: string, status: string): Promise<void> {
    const { node } = await this.projectOctokit.graphql<{
      node: { field: { id: string; options: Array<{ id: string; name: string }> } | null };
    }>(
      `query($id: ID!) { node(id: $id) { ... on ProjectV2 { field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`,
      { id: projectId },
    );
    const option = node.field?.options.find((o) => o.name.toLowerCase() === status.toLowerCase());
    if (!node.field || !option) return;
    await this.projectOctokit.graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { clientMutationId }
      }`,
      { projectId, itemId, fieldId: node.field.id, optionId: option.id },
    );
  }

  async openPr(fullName: string, head: string, title: string, body: string): Promise<number> {
    const [owner, repo] = fullName.split("/");
    const { data: repoInfo } = await this.octokit.repos.get({ owner, repo });
    const { data } = await this.octokit.pulls.create({
      owner,
      repo,
      head,
      base: repoInfo.default_branch,
      title,
      body,
    });
    return data.number;
  }

  async mergePr(fullName: string, prNumber: number): Promise<string> {
    const [owner, repo] = fullName.split("/");
    const { data } = await this.octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: "squash",
    });
    return data.sha;
  }

  async closePr(fullName: string, prNumber: number): Promise<void> {
    const [owner, repo] = fullName.split("/");
    await this.octokit.pulls.update({ owner, repo, pull_number: prNumber, state: "closed" });
  }

  async headSha(dir: string): Promise<string> {
    return (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  }

  /** 레포 삭제. 이미 없으면 false. (fine-grained PAT: Administration Read and write 필요) */
  async deleteRepo(fullName: string): Promise<boolean> {
    const [owner, repo] = fullName.split("/");
    try {
      await this.octokit.repos.delete({ owner, repo });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return false;
      throw err;
    }
  }

  /** GitHub Actions 변수 (비밀 아님) */
  async setVariable(fullName: string, name: string, value: string): Promise<void> {
    const [owner, repo] = fullName.split("/");
    try {
      await this.octokit.actions.createRepoVariable({ owner, repo, name, value });
    } catch {
      await this.octokit.actions.updateRepoVariable({ owner, repo, name, value });
    }
  }

  /** GitHub Actions 시크릿 (레포 공개키로 암호화해서 저장) */
  async setSecret(fullName: string, name: string, value: string): Promise<void> {
    const [owner, repo] = fullName.split("/");
    const { data: key } = await this.octokit.actions.getRepoPublicKey({ owner, repo });
    await sodium.ready;
    const encrypted = sodium.crypto_box_seal(
      sodium.from_string(value),
      sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
    );
    await this.octokit.actions.createOrUpdateRepoSecret({
      owner,
      repo,
      secret_name: name,
      encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
      key_id: key.key_id,
    });
  }
}

export async function configureGitIdentity(dir: string): Promise<void> {
  await exec("git", ["config", "user.name", "pipeline-bot"], { cwd: dir });
  await exec("git", ["config", "user.email", "pipeline-bot@users.noreply.github.com"], { cwd: dir });
}

/** 작업 트리에 변경이 있으면 커밋하고 true */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await exec("git", ["add", "-A"], { cwd: dir });
  const status = await exec("git", ["status", "--porcelain"], { cwd: dir });
  if (!status.stdout.trim()) return false;
  await exec("git", ["commit", "-m", message], { cwd: dir });
  return true;
}
