// Dev mode is enabled by adding ?dev=1 to the URL. Mirrors the ?mobile=1
// pattern used elsewhere — keeps the developer tools (load dev state,
// reset current) out of the way for normal play but always one URL tweak
// away when needed.
export const DEV_MODE: boolean = (() => {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("dev") === "1";
  } catch {
    return false;
  }
})();
