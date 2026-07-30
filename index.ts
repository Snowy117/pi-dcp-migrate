import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DcpController } from "./dcp-controller.ts";

export { getConfig } from "./config.ts";

export default function installDcp(pi: ExtensionAPI): void {
    new DcpController(pi).install();
}
