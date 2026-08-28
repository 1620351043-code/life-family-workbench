export type LifeDeploymentEnvironment = "development" | "test" | "staging" | "production";

export function deploymentEnvironment(env: NodeJS.ProcessEnv = process.env): LifeDeploymentEnvironment {
  const value = (env.LIFE_DEPLOYMENT_ENV || env.NODE_ENV || "development").trim().toLowerCase();
  if (value === "test" || value === "staging" || value === "production") return value;
  return "development";
}

export function isProductionDeployment(env: NodeJS.ProcessEnv = process.env) {
  return deploymentEnvironment(env) === "production";
}

export function isSecureDeployment(env: NodeJS.ProcessEnv = process.env) {
  const current = deploymentEnvironment(env);
  return current === "staging" || current === "production";
}
