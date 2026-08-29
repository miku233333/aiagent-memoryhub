import { HUB_ORIGIN } from "./constants";

export type RequestHeaders = Record<string, string>;

export function withHubAuthorization(
  targetURL: string,
  requestHeaders: RequestHeaders,
  hubToken: string,
): RequestHeaders {
  let target: URL;
  try {
    target = new URL(targetURL);
  } catch {
    return requestHeaders;
  }
  if (
    target.origin !== HUB_ORIGIN ||
    (target.pathname !== "/v1" && !target.pathname.startsWith("/v1/"))
  ) {
    return requestHeaders;
  }
  const sanitizedHeaders = Object.fromEntries(
    Object.entries(requestHeaders).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
  return {
    ...sanitizedHeaders,
    Authorization: `Bearer ${hubToken}`,
  };
}
