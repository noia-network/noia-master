import * as WebRtcDirect from "@noia-network/webrtc-direct-client";
import * as wrtc from "wrtc";

enum ExitStatus {
    Success = 0
}

export interface WebRtcCheckResult {
    id: string;
    status: "success" | "failure";
    message: string;
}

async function main(nodeId: string, ip: string, port: number, candidateIp: string): Promise<void> {
    setTimeout(() => {
        const message = `WebRTC connection failed. Port ${port} or IP ${ip} might be unreachable (timeout).`;
        const timeoutResult: WebRtcCheckResult = { id: nodeId, message: message, status: "failure" };
        console.info(JSON.stringify(timeoutResult));
        process.exit();
    }, 2 * 60 * 1000);

    const result = await checkWebrtc(nodeId, ip, port, candidateIp);
    console.info(JSON.stringify(result));
    process.exit(ExitStatus.Success);
}
main(process.argv[2], process.argv[3], parseInt(process.argv[4]), process.argv[5]);

async function checkWebrtc(nodeId: string, ip: string, port: number, candidateIp: string): Promise<WebRtcCheckResult> {
    try {
        const client = new WebRtcDirect.Client(`http://${ip}:${port}`, {
            wrtc: wrtc,
            candidateIp: candidateIp
        });
        await client.connect();
        await client.stop();
        return {
            id: nodeId,
            message: `Node node-id=${nodeId} WebRTC check succeeded.`,
            status: "success"
        };
    } catch (err) {
        const message = `WebRTC connection failed. Port ${port} or IP ${ip} might be unreachable.`;
        return {
            id: nodeId,
            message: message,
            status: "failure"
        };
    }
}
