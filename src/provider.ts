import { Node } from "./contracts";

type ProvidersList = {
    [name: string]: ProviderData;
};

interface ProviderData {
    isPrivate: boolean;
}

const providersList: ProvidersList = {
    "noia.network": {
        isPrivate: true
    }
};

class Provider {
    public integrity(providerName: string, node: Node): boolean {
        if (!this.check(providerName)) {
            return false;
        }

        for (const prop in providersList[providerName]) {
            if (
                providersList[providerName].hasOwnProperty(prop) &&
                node[prop as keyof Node] !== providersList[providerName][prop as keyof ProviderData]
            ) {
                return true;
            }
        }

        return false;
    }

    private check(providerName: string): boolean {
        return providersList[providerName] == null;
    }
}

export let provider = new Provider();
