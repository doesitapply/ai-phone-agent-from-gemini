export type DeployIdentity = {
  version: string;
  branch: string;
};

type DeployIdentityEnvironment = Record<string, string | undefined>;

const firstNonBlank = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
};

/**
 * Resolve the source identity exposed by the running app.
 *
 * GitHub-source deployments receive Railway's immutable Git metadata, so it
 * must win over manually stamped variables that can outlive their deployment.
 * Archive/CLI deployments do not receive that metadata and continue to use the
 * reviewed SMIRK_DEPLOY_* stamp as their first fallback.
 */
export function resolveDeployIdentity(
  environment: DeployIdentityEnvironment = process.env,
): DeployIdentity {
  return {
    version: firstNonBlank(
      environment.RAILWAY_GIT_COMMIT_SHA,
      environment.SMIRK_DEPLOY_VERSION,
      environment.SOURCE_VERSION,
      environment.VERCEL_GIT_COMMIT_SHA,
      environment.npm_package_version,
    ) || "dev",
    branch: firstNonBlank(
      environment.RAILWAY_GIT_BRANCH,
      environment.SMIRK_DEPLOY_BRANCH,
      environment.VERCEL_GIT_COMMIT_REF,
      environment.GITHUB_REF_NAME,
    ) || "unknown",
  };
}
