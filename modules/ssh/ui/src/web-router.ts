import { useEffect, useState } from "react";

export const LOGIN_ROUTE = "/login";
export const DASHBOARD_ROUTE = "/dashboard";

/**
 * Router history-API minimal untuk WAN SSH Web Gateway. Web gateway hanya
 * mempunyai satu workspace terproteksi (`/dashboard`) dan satu halaman publik
 * (`/login`); path internal lain diarahkan ke salah satu dari keduanya oleh
 * guard di `WebRoot`.
 */
const ROUTE_CHANGE_EVENT = "wan-ssh:route-change";

export function currentRoute(): string {
  const path = window.location.pathname;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function navigateRoute(path: string, replace = false): void {
  if (currentRoute() === path) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", path);
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
}

export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const sync = () => setRoute(currentRoute());
    window.addEventListener("popstate", sync);
    window.addEventListener(ROUTE_CHANGE_EVENT, sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(ROUTE_CHANGE_EVENT, sync);
    };
  }, []);
  return route;
}
