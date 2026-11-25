# 1회만 실행하는 AWS 부트스트랩.
# - GitHub Actions OIDC 공급자
# - 앱 레포들이 맡을 배포 역할 (GITHUB_OWNER 아래 모든 레포)
# - Terraform state 버킷
#
#   cd infra/bootstrap
#   terraform init && terraform apply -var github_owner=<GITHUB_OWNER>
#
# 출력값 deploy_role_arn / state_bucket 을 pipeline .env 의
# AWS_DEPLOY_ROLE_ARN / AWS_TF_STATE_BUCKET 에 넣는다.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "github_owner" {
  type        = string
  description = "앱 레포가 만들어지는 GitHub 사용자/조직 (pipeline .env 의 GITHUB_OWNER)"
}

provider "aws" {
  region = var.region
  default_tags { tags = { managed_by = "pipeline-bootstrap" } }
}

data "aws_caller_identity" "me" {}

locals {
  account = data.aws_caller_identity.me.account_id
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_s3_bucket" "state" {
  bucket = "pipeline-tfstate-${local.account}-${var.region}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "deploy" {
  name = "pipeline-app-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        # main 브랜치에서 돌아가는 워크플로만 배포 가능
        StringLike = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_owner}/*:ref:refs/heads/main" }
      }
    }]
  })
}

# 앱 템플릿(Lambda + API Gateway + DynamoDB)이 쓰는 범위로 제한한 배포 권한
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "State"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      },
      {
        Sid       = "AppServices"
        Effect    = "Allow"
        Action    = ["lambda:*", "apigateway:*", "dynamodb:*", "logs:*"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid    = "LambdaRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy", "iam:DetachRolePolicy"
        ]
        # 앱 템플릿의 Lambda 역할 이름 규칙: <slug>-api-lambda
        Resource = "arn:aws:iam::${local.account}:role/*-api-lambda"
      }
    ]
  })
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}
