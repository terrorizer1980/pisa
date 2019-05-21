import { StartStopService, ArgumentError } from "../dataEntities";
import { BlockProcessor } from "./blockProcessor";
import { BlockCache } from "./blockCache";
import { CancellablePromise } from "../utils";

interface ITransactionListenerData {
    txHash: string;
    resolver: () => void;
    rejecter: (error: Error) => void;
    confirmationsRequired: number;
    throwReorgIfNotFound: boolean;
    initialHeight: number | null;
    blockThresholdForStuckTransactions: number | null;
}

/**
 * A simple custom Error class to signal that the speified number of blocks has been mined.
 */
export class BlockThresholdReachedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BlockThresholdReachedError";
    }
}

/**
 * A simple custom Error class to provide more details in case of a re-org.
 */
export class ReorgError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReorgError";
    }
}

/**
 * Allows to observe transactions to be notified when they reach a given number of confirmations.
 */
export class ConfirmationObserver extends StartStopService {
    private txListenerResolvers = new Set<ITransactionListenerData>();
    private firstBlockHeightSeen: number | null = null;

    constructor(private readonly blockCache: BlockCache, private readonly blockProcessor: BlockProcessor) {
        super("Confirmation Observer");
        this.handleNewHead = this.handleNewHead.bind(this);
    }

    protected async startInternal(): Promise<void> {
        this.blockProcessor.on(BlockProcessor.NEW_HEAD_EVENT, this.handleNewHead);
    }

    protected async stopInternal(): Promise<void> {
        this.blockProcessor.removeListener(BlockProcessor.NEW_HEAD_EVENT, this.handleNewHead);
    }

    private handleNewHead(blockNumber: number, blockHash: string) {
        if (this.firstBlockHeightSeen === null) {
            this.firstBlockHeightSeen = blockNumber;
        }
        // Make a copy of the listenerData
        const txListenerResolversCopy = new Set(this.txListenerResolvers);

        // Verify for each waiting transaction, verify if the number of confirmations was reached.
        // Note: this is relatively inefficient if there are many listeners, as it does O(maxDepth) work per listener.
        for (let listenerData of txListenerResolversCopy) {
            const {
                txHash,
                confirmationsRequired,
                initialHeight,
                throwReorgIfNotFound,
                blockThresholdForStuckTransactions,
                resolver,
                rejecter
            } = listenerData;

            // if initialHeight was not known, use first known block height
            const adjInitialHeight = initialHeight || this.firstBlockHeightSeen;

            const txConfirmations = this.blockCache.getConfirmations(blockHash, txHash);
            if (txConfirmations >= confirmationsRequired) {
                this.txListenerResolvers.delete(listenerData);
                resolver();
            } else if (throwReorgIfNotFound && txConfirmations === 0) {
                rejecter(
                    new ReorgError("There could have been a re-org, the transaction was sent but was later not found")
                );
            } else if (txConfirmations === 0 && blockThresholdForStuckTransactions != null) {
                if (blockNumber >= adjInitialHeight + blockThresholdForStuckTransactions) {
                    // transaction still unconfirmed after the threshold; reject
                    this.txListenerResolvers.delete(listenerData);
                    rejecter(new BlockThresholdReachedError("Block threshold reached"));
                }
            }
        }
    }

    public waitForConfirmations(
        txHash: string,
        confirmationsRequired: number,
        blockThresholdForStuckTransactions: number | null,
        throwReorgIfNotFound: boolean
    ): CancellablePromise<void> {
        const listenerData: ITransactionListenerData = {
            txHash,
            confirmationsRequired,
            throwReorgIfNotFound,
            initialHeight: this.blockProcessor.head !== null ? this.blockProcessor.head.number : null,
            blockThresholdForStuckTransactions,
            resolver: () => {}, // temporary, will be overwritten
            rejecter: () => {} // temporary, will be overwritten
        };

        const canceller = () => this.txListenerResolvers.delete(listenerData);

        return new CancellablePromise(async (resolve, reject) => {
            if (confirmationsRequired > this.blockCache.maxDepth) {
                reject(new ArgumentError("confirmationRequired cannot be bigger than the BlockCache's maxDepth."));
            }

            const txConfirmations =
                this.blockProcessor.head !== null
                    ? this.blockCache.getConfirmations(this.blockProcessor.head.hash, txHash)
                    : 0;
            if (txConfirmations >= confirmationsRequired) {
                // Already has enough confirmations, resolve immediately
                resolve();
            } else {
                listenerData.resolver = resolve;
                listenerData.rejecter = reject;

                // Add to the listeners to be resolved in the future
                this.txListenerResolvers.add(listenerData);
            }
        }, canceller);
    }
}
