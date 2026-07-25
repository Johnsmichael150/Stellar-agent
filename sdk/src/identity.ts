import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
  Address,
  xdr,
  StrKey,
  rpc,
} from "@stellar/stellar-sdk";
import type { Agent, MarcConfig } from "./types.js";
import { BaseClient } from "./baseClient.js";

/**
 * Typed wrapper around the `agent_identity` Soroban contract.
 *
 * Provides methods to register agents, query agent data, update URIs, and manage
 * ownership. All methods handle ScVal encoding/decoding, transaction building, and
 * submission via Soroban RPC automatically.
 *
 * @example
 * ```typescript
 * const client = new IdentityClient(TESTNET);
 * const agentId = await client.register(ownerKeypair, "ipfs://metadata-uri");
 * const agent = await client.getAgent(agentId);
 * await client.disconnect();
 * ```
 */
export class IdentityClient extends BaseClient {
  private contract: Contract;

  /**
   * Initialize the IdentityClient with a configuration.
   *
   * @param cfg - Configuration containing RPC URL, network passphrase, contract address, etc.
   */
  constructor(cfg: MarcConfig) {
    super(cfg);
    this.contract = new Contract(cfg.identityContract);
  }

  /**
   * Register a new agent and return its on-chain ID.
   *
   * Accepts the owner's `Keypair` and handles the full transaction lifecycle
   * automatically: builds the transaction, fetches the account sequence number,
   * calls `prepareTransaction` to simulate and attach the Soroban footprint,
   * signs with the provided keypair, submits via `sendTransaction`, and polls
   * until the transaction is finalized on-chain. The caller does not need to
   * build or sign anything manually.
   *
   * @param owner - The owner's Keypair. Used both as the on-chain `owner`
   *                address and to sign the transaction.
   * @param uri   - Metadata URI for the agent (e.g. a DID document URL).
   * @returns The assigned on-chain agent ID as a `bigint`.
   */
  async register(owner: Keypair, uri: string): Promise<bigint> {
    // Client-side guard: validate the owner's public key is a well-formed
    // Stellar Ed25519 address (starts with 'G', 56 chars, valid checksum).
    // Without this check the error surfaces as an opaque RPC failure; catching
    // it here gives callers a clear, actionable message before any network call.
    if (!StrKey.isValidEd25519PublicKey(owner.publicKey())) {
      throw new Error(
        `register: invalid Stellar address "${owner.publicKey()}" — must be a valid Ed25519 public key (starts with G)`,
      );
    }

    const op = this.contract.call(
      "register",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(uri, { type: "string" }),
    );
    return await this.invoke(owner, op, (v) => BigInt(scValToNative(v) as string), "identity");
  }

  /**
   * Look up an agent by its numeric ID.
   *
   * @param id - The agent's on-chain ID
   * @returns The agent record, or null if the ID does not exist
   */
  async getAgent(id: bigint): Promise<Agent | null> {
    const op = this.contract.call(
      "get_agent",
      nativeToScVal(id, { type: "u64" }),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      if (!native) return null;
      return {
        id: BigInt(native.id),
        owner: native.owner,
        uri: native.uri,
      } as Agent;
    });
  }

  /**
   * Reverse-lookup: find the agent ID owned by an address.
   *
   * @param owner - The owner's Stellar address
   * @returns The agent ID owned by this address, or null if none exists
   */
  async agentOf(owner: string): Promise<bigint | null> {
    const op = this.contract.call(
      "agent_of",
      new Address(owner).toScVal(),
    );
    return await this.simulate(op, (v) => {
      const native = scValToNative(v);
      return native == null ? null : BigInt(native);
    });
  }

  /**
   * Update an agent's metadata URI (owner-only).
   *
   * @param owner - The agent's owner keypair for authorization
   * @param id - The agent's ID
   * @param uri - New metadata URI (e.g., IPFS or HTTP URL)
   */
  async updateUri(owner: Keypair, id: bigint, uri: string): Promise<void> {
    const op = this.contract.call(
      "update_uri",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(id, { type: "u64" }),
      nativeToScVal(uri, { type: "string" }),
    );
    await this.invoke(owner, op, () => undefined, "identity");
  }

  /**
   * List all registered agents by scanning sequential IDs up to maxId.
   *
   * @param maxId - Maximum ID to scan (default 200). Continues past gaps.
   * @returns Array of all registered agents with IDs from 1 to maxId
   */
  async listAgents(maxId = 200n): Promise<Agent[]> {
    const agents: Agent[] = [];
    for (let id = 1n; id <= maxId; id++) {
      const agent = await this.getAgent(id);
      if (!agent) continue;
      agents.push(agent);
    }
    return agents;
  }

  /**
   * Transfer ownership of an agent to a new wallet.
   *
   * The contract requires auth from both the current owner and the new owner.
   * Pass both keypairs; the transaction is submitted by `owner` and signed by
   * `newOwner` as well.
   */
  async updateOwner(owner: Keypair, id: bigint, newOwner: Keypair): Promise<void> {
    const op = this.contract.call(
      "update_owner",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(id, { type: "u64" }),
      new Address(newOwner.publicKey()).toScVal(),
    );
    await this.invokeMultiSig(owner, newOwner, op, "identity");
  }

  /**
   * Permanently remove an agent from the registry (owner-only).
   *
   * @param owner - The agent's owner keypair for authorization
   * @param id - The agent's ID to deregister
   */
  async deregister(owner: Keypair, id: bigint): Promise<void> {
    const op = this.contract.call(
      "deregister",
      new Address(owner.publicKey()).toScVal(),
      nativeToScVal(id, { type: "u64" }),
    );
    await this.invoke(owner, op, () => undefined, "identity");
  }


  /**
   * Get the balance of `address` for a given token.
   * Pass `"native"` for XLM (returns stroops as bigint),
   * or a Soroban token contract address for SAC/custom tokens.
   */
  async getBalance(address: string, token: string): Promise<bigint> {
    if (token === "native") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const account = (await this.server.getAccount(address)) as any;
      const xlmBalance = account.balances.find((b: any) => b.asset_type === "native");
      return BigInt(Math.round(Number(xlmBalance?.balance ?? "0") * 1e7));
    }
    const tokenContract = new Contract(token);
    const op = tokenContract.call("balance", new Address(address).toScVal());
    return await this.simulate(op, (v) => BigInt(scValToNative(v) as string));
  }

  // --- internals ---

  /** Submit a transaction signed by two keypairs (old owner + new owner). */
  private async invokeMultiSig(signer1: Keypair, signer2: Keypair, op: xdr.Operation, txLabel: string): Promise<void> {
    const account = await this.server.getAccount(signer1.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer1);
    prepared.sign(signer2);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error(`submit failed: ${sent.errorResult}`);
    let getResp = await this.server.getTransaction(sent.hash);
    while (getResp.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResp = await this.server.getTransaction(sent.hash);
    }
    if (getResp.status !== "SUCCESS") {
      const failed = getResp as rpc.Api.GetFailedTransactionResponse;
      const detail = failed.resultXdr?.result()?.switch()?.name ?? getResp.status;
      throw new Error(`tx failed: ${detail}`);
    }
    this.cfg.onTx?.(sent.hash, txLabel);
  }
}
