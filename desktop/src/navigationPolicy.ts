import { HUB_ORIGIN, RELEASE_OWNER, RELEASE_REPOSITORY } from "./constants";

export type NavigationDecision =
  | "allow-local"
  | "open-release-external"
  | "deny";

const releasePath = `/${RELEASE_OWNER}/${RELEASE_REPOSITORY}/releases`;

export function classifyNavigation(rawURL: string): NavigationDecision {
  let target: URL;
  try {
    target = new URL(rawURL);
  } catch {
    return "deny";
  }

  if (target.username !== "" || target.password !== "") {
    return "deny";
  }

  if (target.origin === HUB_ORIGIN) {
    return "allow-local";
  }

  const isExactGitHubRelease =
    target.protocol === "https:" &&
    target.hostname === "github.com" &&
    target.port === "" &&
    (target.pathname === releasePath ||
      target.pathname === `${releasePath}/` ||
      target.pathname.startsWith(`${releasePath}/`));

  return isExactGitHubRelease ? "open-release-external" : "deny";
}
