import { NeoDeviceClient } from "../../../clients/web/neo-client";

declare global {
  interface Window {
    neoTest: {
      create(scope: string): Promise<NeoDeviceClient>;
      setNetworkAvailable(value: boolean): void;
    };
  }
}

let networkAvailable = true;
window.neoTest = {
  create: (scope) => NeoDeviceClient.create("https://neo.test", async () => "test-access-token", scope),
  setNetworkAvailable: (value) => { networkAvailable = value; },
};
window.addEventListener("neo-test-network", ((event: CustomEvent<boolean>) => {
  networkAvailable = event.detail;
}) as EventListener);
