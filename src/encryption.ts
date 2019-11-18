import CryptoJS from "crypto-js";
import sha1 from "sha1";

import { config, ConfigOption } from "./config";

export class Encryption {
    public encrypt(
        key: string,
        buffer: Buffer,
        // By passing iv some security is sacrifisted in order to get constitent digest of encrypted data.
        iv: string
    ): Buffer {
        const dataWordArray = CryptoJS.lib.WordArray.create(buffer);
        const ciphertext = CryptoJS.AES.encrypt(dataWordArray, CryptoJS.enc.Hex.parse(key), { iv: CryptoJS.enc.Hex.parse(iv) });

        return Buffer.from(ciphertext.toString());
    }

    public decrypt(key: string | null, buffer: Buffer): Buffer {
        const ciphertext = buffer.toString();
        const bytes = CryptoJS.AES.decrypt(ciphertext, key != null ? CryptoJS.enc.Hex.parse(key) : "");
        const plaintext = bytes.toString(CryptoJS.enc.Base64);
        const decryptedBuffer = Buffer.from(plaintext, "base64");

        return decryptedBuffer;
    }

    public getSecretKey(contentId: string): string {
        return sha1(contentId + config.get(ConfigOption.ContentEncryptionSecretSalt)).substring(0, 32);
    }
}

export let encryption = new Encryption();
