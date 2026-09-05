import { OwnerApp } from "./OwnerApp";
import { PublicRouter } from "./PublicApp";
import "./workfloor.css";

export default function AppV2() {
  return window.location.pathname.startsWith("/dashboard") ? <OwnerApp /> : <PublicRouter />;
}
