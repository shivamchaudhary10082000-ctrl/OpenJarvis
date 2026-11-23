import { NeoDeviceClient } from "../../../clients/web/neo-client";
declare global {
  interface Window {
    neoTest: { create(scope: string): Promise<NeoDeviceClient> };
  }
}
window.neoTest = {
  create: (scope) => NeoDeviceClient.create("https://neo.test", async () => "test-access-token", scope),
};
