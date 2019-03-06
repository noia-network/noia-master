import * as CryptoJS from "crypto-js";
import * as sha1 from "sha1";

import { config, ConfigOption } from "./config";

export class Encryption {
    public encrypt(key: string, buffer: Buffer): Buffer {
        const dataWordArray = CryptoJS.lib.WordArray.create(buffer);
        const ciphertext = CryptoJS.AES.encrypt(dataWordArray, key);

        return Buffer.from(ciphertext.toString());
    }

    public decrypt(key: string | null, buffer: Buffer): Buffer {
        const ciphertext = buffer.toString();
        const bytes = CryptoJS.AES.decrypt(ciphertext, key != null ? key : "");
        const plaintext = bytes.toString(CryptoJS.enc.Base64);
        const decryptedBuffer = Buffer.from(plaintext, "base64");

        return decryptedBuffer;
    }

    public getSecretKey(contentId: string): string {
        return sha1(contentId + config.get(ConfigOption.ContentEncryptionSecretSalt)).substring(10, 30);
    }
}

export let encryption = new Encryption();
