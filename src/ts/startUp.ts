import { PisaService } from "./service";
import { ethers } from "ethers";
import { IConfig } from "./dataEntities/config";
import { KitsuneWatcher } from "./watcher";
import { KitsuneInspector } from "./inspector";
const config = require("./config.json") as IConfig;

// TODO: to start the service we need a valid provider - we should be doing a provider check first
// TODO: should we have the option of starting up a local ganache-core rather than supplying a url
const provider = new ethers.providers.JsonRpcProvider(config.jsonRpcUrl);
provider.pollingInterval = 100;
const watcherWallet = new ethers.Wallet(config.watcherKey, provider);
const watcher = new KitsuneWatcher(provider, watcherWallet);
const inspector = new KitsuneInspector(10, provider);

// start the pisa service
const service = new PisaService(config.host.name, config.host.port, inspector, watcher);

// wait for a stop signal
waitForStop();

function waitForStop() {
    const stdin = process.stdin;

    // without this, we would only get streams once enter is pressed
    stdin.setRawMode(true);

    // resume stdin in the parent process (node app won't quit all by itself
    // unless an error or process.exit() happens)
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", key => {
        // ctrl-c ( end of text )
        if (key === "\u0003") {
            // stop the pisa service
            service.stop()
            // exit the process
            process.exit();
        }
        // otherwise write the key to stdout all normal like
        process.stdout.write(key);
    });
}
