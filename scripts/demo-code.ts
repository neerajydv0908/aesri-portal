/** Print the current authenticator code for the demo administrators (local testing only). */
import { Secret, TOTP } from "otpauth";
import { DEMO_TOTP_SECRET } from "../lib/demo/core";

const code = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(DEMO_TOTP_SECRET) }).generate();
console.log(`Demo authenticator code: ${code}  (changes every 30 seconds)`);
