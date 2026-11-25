import { Octokit } from "@octokit/rest";
import sodium from "libsodium-wrappers";
import { exec } from "../util/exec.js";

export class GitHub {
  readonly octokit: Octokit;
  private ownerIsOrg: boolean | undefined;

  constructor(
    private token: string,
    readonly owner: string,
  ) {
    this.octokit = new Octokit({ auth: token });
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
