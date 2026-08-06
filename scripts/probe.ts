import { resolveRemoteCode } from "./remoteCode";

const host = process.argv[2] ?? "yecl-gpu-server";
const codePath = process.argv[3]; // optional explicit path

resolveRemoteCode(host, codePath)
    .then((info) => console.log("OK:", info))
    .catch((err) => {
        console.error(`FAIL [${err.kind}]: ${err.message}`);
        process.exit(1);
    });