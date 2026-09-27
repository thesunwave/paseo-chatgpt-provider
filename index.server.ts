import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createChatGptCodexifyProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createChatGptCodexifyProvider());
  return () => {};
}
