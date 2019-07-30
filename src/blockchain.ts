// import { NoiaSdk } from "@noia-network/governance";
// const noiaGovSDK = new NoiaSdk();
// import { WorkOrder, BusinessClient, JobPost } from "@noia-network/governance";

// import { config, ConfigOption } from "./config";
// import { db } from "./db";
// import { logger } from "./logger";

// export class Blockchain {
//     /**
//      * Master business client.
//      */
//     private businessClient?: BusinessClient;

//     /**
//      * Initialize NOIA governance SDK, create new or retrieve existing master business client and shedule job posts creation.
//      */
//     public async setup(): Promise<void> {
//         if (!config.get(ConfigOption.BlockchainIsEnabled)) {
//             logger.warn("Blockchain initialization is skipped!");
//             return;
//         }

//         // Initialize NOIA governance SDK.
//         try {
//             await noiaGovSDK.init({
//                 account: {
//                     mnemonic: config.get(ConfigOption.BlockchainMnemonic)
//                 },
//                 web3: {
//                     provider_url: config.get(ConfigOption.BlockchainProviderUrl)
//                 }
//             });
//             logger.blockchain(`Master wallet-address=${this.getWalletAddress()}.`);
//         } catch (err) {
//             logger.error("Cannot connect to blockchain: ", err);
//         }

//         // Initialize NOIA governance business client.
//         const businessClientAddress = db.settings().view({ key: "business-client-address" }) as string | undefined;
//         if (businessClientAddress != null && (await noiaGovSDK.isBusinessRegistered(businessClientAddress))) {
//             try {
//                 this.businessClient = await noiaGovSDK.getBusinessClient(businessClientAddress);
//                 logger.blockchain(`Master (existing) business client: business-client-address=${businessClientAddress}.`);
//             } catch (err) {
//                 logger.error("Failed to register business client:", err);
//             }
//         } else {
//             this.businessClient = await noiaGovSDK.createBusinessClient({
//                 host: config.get(ConfigOption.MasterDomain),
//                 port: config.get(ConfigOption.ProtocolsWsNodePort)
//             });
// tslint:disable-next-line:max-line-length
//             db.settings().set({ key: "business-client-address" }, { key: "business-client-address", value: this.businessClient.address });
//             logger.blockchain(`Mastter (created) business client: business-client-address=${this.businessClient.address}.`);
//         }

//         this.scheduleJobsPosting();
//     }

//     /**
//      * Create job post instantly and schedule future job posts creation in given interval.
//      */
//     private async scheduleJobsPosting(): Promise<void> {
//         await this.createJobPost();
//         setInterval(() => {
//             this.createJobPost();
//         }, config.get(ConfigOption.BlockchainJobPostInterval) * 1000);
//     }

//     /**
//      * Create a job post.
//      */
//     public async createJobPost(): Promise<void> {
//         const jobPost = await this.getBusinessClient().createJobPost({});
//         const etherBalance = await noiaGovSDK.getEtherBalance(noiaGovSDK.getOwnerAddress());
//         logger.blockchain(`Created job post: job-post-address=${jobPost.address}, eth-balance=${etherBalance}.`);
//     }

//     /**
//      * Recover wallet address from remote procedure call signed message.
//      */
//     public recoverAddressFromSignedMessage(msg: string, msgSigned: string): string {
//         return noiaGovSDK.recoverAddressFromRpcSignedMessage(msg, msgSigned);
//     }

//     /**
//      * Sign text message.
//      */
//     public async signMessage(msg: string): Promise<string> {
//         const baseClient = await noiaGovSDK.getBaseClient();
//         const signedMsg = await baseClient.rpcSignMessage(msg);
//         return signedMsg;
//     }

//     /**
//      * Create work order.
//      */
//     public async createWorkOrder(jobPostAddress: string, workerAddress: string): Promise<WorkOrder> {
//         const jobPost = await noiaGovSDK.getJobPost(jobPostAddress);
//         const workOrder = await jobPost.createWorkOrder(workerAddress);
//         return workOrder;
//     }

//     /**
//      * Get job post.
//      */
//     public async getJobPost(jobPostAddress: string): Promise<JobPost> {
//         const jobPost = await noiaGovSDK.getJobPost(jobPostAddress);
//         return jobPost;
//     }

//     /**
//      * Get work order from job post and work order address.
//      */
//     public async getWorkOrderAt(jobPostAddress: string, workOrderAddress: string): Promise<WorkOrder> {
//         // TODO: Validate.
//         const jobPost = await noiaGovSDK.getJobPost(jobPostAddress);
//         const workOrder = jobPost.getWorkOrderAt(workOrderAddress);
//         return workOrder;
//     }

//     /**
//      * Lock NOIA tokens.
//      */
//     public async lockTokens(workOrder: WorkOrder, amountNoia: number, timeoutSeconds: number): Promise<void> {
//         const amountWeis = noiaGovSDK.noiaTokensToWeis(amountNoia);
//         const noiaBalance = await noiaGovSDK.getNoiaBalance(noiaGovSDK.getOwnerAddress());
//         await noiaGovSDK.transferNoiaToken(workOrder.address, amountWeis);
//         const currentTimeSeconds = new Date().getTime() / 1000;
//         const timeout = timeoutSeconds + currentTimeSeconds;
//         await workOrder.timelock(amountWeis, timeoutSeconds + currentTimeSeconds);
//         logger.blockchain(`Locked NOIA tokens: noia-balace=${noiaBalance} amount=${amountWeis}, timeout=${timeout}.`);
//     }

//     /**
//      * Get wallet (owner) address.
//      */
//     public getWalletAddress(): string {
//         return noiaGovSDK.getOwnerAddress();
//     }

//     /**
//      * Get business client.
//      */
//     public getBusinessClient(): BusinessClient {
//         if (this.businessClient == null) {
//             const msg = "Business client is invalid.";
//             logger.error(msg);
//             throw new Error(msg);
//         }
//         return this.businessClient;
//     }

//     /**
//      * Get business client at address.
//      */
//     public async getBusinessClientAt(address: string): Promise<BusinessClient> {
//         return await noiaGovSDK.getBusinessClient(address);
//     }
// }

// export let blockchain = new Blockchain();
