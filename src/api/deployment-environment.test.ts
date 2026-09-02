import { describe, expect, it } from "vitest";
import { deploymentEnvironment, isProductionDeployment, isSecureDeployment } from "./deployment-environment.js";

describe("deployment environment", () => {
  it("treats staging and production as secure deployments", () => {
    expect(deploymentEnvironment({ LIFE_DEPLOYMENT_ENV: "staging" })).toBe("staging");
    expect(isSecureDeployment({ LIFE_DEPLOYMENT_ENV: "staging" })).toBe(true);
    expect(isProductionDeployment({ LIFE_DEPLOYMENT_ENV: "staging" })).toBe(false);
    expect(isSecureDeployment({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionDeployment({ NODE_ENV: "production" })).toBe(true);
  });

  it("does not silently promote unknown environments", () => {
    expect(deploymentEnvironment({ LIFE_DEPLOYMENT_ENV: "preview" })).toBe("development");
    expect(isSecureDeployment({ LIFE_DEPLOYMENT_ENV: "preview" })).toBe(false);
  });
});
