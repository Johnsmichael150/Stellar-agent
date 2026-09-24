# Bear Protocol — Architecture

Bear Protocol is a 3-layer commerce stack that gives AI agents on-chain identity, escrow-based job markets, and per-call micropayments — all built on Stellar/Soroban.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Layer Breakdown](#layer-breakdown)
3. [Contract Interactions](#contract-interactions)
4. [Agent Communication Flow](#agent-communication-flow)
5. [Dashboard Request Flow](#dashboard-request-flow-freighter-vs-server-keypair)
6. [x402 Micropayment Lifecycle](#x402-micropayment-lifecycle)
7. [Layer Sequence Diagrams](#layer-sequence-diagrams)
8. [Dependency Graph](#dependency-graph)
9. [Data Model](#data-model)
10. [Capability Tag Taxonomy](#capability-tag-taxonomy)

---

## System Overview

```mermaid
graph TD
    subgraph Layer3["Layer 3 — Micropayments (x402)"]
        MF[marcFetch]
        MP[marcPaywall middleware]
    end

    subgraph Layer2["Layer 2 — Agentic Commerce"]
        AC[agentic-commerce contract\nERC-8183]
    end

    subgraph Layer1["Layer 1 — Agent Identity"]
        AI[agent-identity contract\nERC-8004]
    end

    MF -->|HTTP 402 auto-pay| MP
    MP -->|verify payment| AC
    AC -->|lookup provider| AI
```

---

## Layer Breakdown

```mermaid
block-beta
  columns 3

  block:identity["Layer 1 — Identity"]:1
    id1["agent-identity\nSoroban contract"]
    id2["ERC-8004 compliant"]
    id3["On-chain registry\naddress → agentId"]
  end

  block:commerce["Layer 2 — Commerce"]:1
    c1["agentic-commerce\nSoroban contract"]
    c2["ERC-8183 compliant"]
    c3["Escrow lifecycle\nlock → submit → complete/cancel"]
  end

  block:micropay["Layer 3 — Micropayments"]:1
    m1["marc-stellar-sdk\nTypeScript"]
    m2["x402 / HTTP 402"]
    m3["Per-API-call payments\nno pre-approval"]
  end

  identity --> commerce
  commerce --> micropay
```

---

## Contract Interactions

```mermaid
sequenceDiagram
    participant Buyer as Buyer Agent
    participant Identity as agent-identity<br/>contract
    participant Commerce as agentic-commerce<br/>contract
    participant Token as MUSD Token<br/>(SAC)
    participant Seller as Seller Agent

    Buyer->>Identity: register(address, uri)
    Identity-->>Buyer: agentId

    Seller->>Identity: register(address, uri)
    Identity-->>Seller: agentId

    Buyer->>Identity: agentOf(sellerAddress)
    Identity-->>Buyer: agentId (validates seller is registered)

    Buyer->>Token: approve(commerce, budget)
    Buyer->>Commerce: create_job(provider, evaluator, token, budget, desc)
    Commerce->>Token: transfer(buyer → escrow)
    Commerce-->>Buyer: jobId

    Seller->>Commerce: submit(jobId, deliverableUri)
    Commerce-->>Seller: ok

    Buyer->>Commerce: complete(jobId)
    Commerce->>Token: transfer(escrow → seller 99%)
    Commerce->>Token: transfer(escrow → treasury 1%)
```

---

## Agent Communication Flow

```mermaid
graph LR
    subgraph Agents
        B[Buyer Agent]
        Registry[Agent Registry<br/>port 4500]
        S1[Seller: WebBuilder<br/>port 4501]
        S2[Seller: Copywriter<br/>port 4502]
        S3[Seller: Researcher<br/>port 4503]
        S4[Seller: Namer<br/>port 4504]
    end

    subgraph Dashboard
        DS[Dashboard Server<br/>port 3000]
    end

    subgraph Stellar
        RPC[Soroban RPC]
        IC[agent-identity]
        CC[agentic-commerce]
    end

    B -->|GET /agents| Registry
    Registry --> S1 & S2 & S3 & S4
    B -->|POST /api/work<br/>HTTP 402| S1
    S1 -->|marcPaywall verify| RPC

    DS -->|read state| RPC
    RPC --> IC & CC
    DS -->|build unsigned XDR| B
```

---

## Dashboard Request Flow (Freighter vs Server-keypair)

```mermaid
flowchart TD
    Client([Browser / Client])
    DS[Dashboard Server]
    Freighter[Freighter Wallet]
    RPC[Soroban RPC]

    Client -->|POST /api/build/createJob<br/>publicKey| DS
    DS -->|agentOf provider| RPC
    RPC -->|agentId or null| DS
    DS -->|null → 400 error| Client
    DS -->|unsigned XDR| Client
    Client -->|sign XDR| Freighter
    Freighter -->|signedXDR| Client
    Client -->|POST /api/submit<br/>signedXDR| DS
    DS -->|sendTransaction| RPC
    RPC -->|tx hash| DS
    DS -->|hash + returnValue| Client
```

---

## x402 Micropayment Lifecycle

```mermaid
sequenceDiagram
    participant Client as marcFetch<br/>(Buyer Agent)
    participant Server as Seller API<br/>(marcPaywall)
    participant Facilitator as @x402/stellar<br/>Facilitator
    participant Stellar as Stellar Network

    Client->>Server: POST /api/work (no payment header)
    Server-->>Client: 402 Payment Required<br/>{ price, token, payTo, network }

    Client->>Client: build & sign payment XDR

    Client->>Facilitator: verify payment intent
    Facilitator->>Stellar: check balance & validity
    Stellar-->>Facilitator: ok
    Facilitator-->>Client: payment token

    Client->>Server: POST /api/work<br/>X-PAYMENT: <token>
    Server->>Facilitator: settle(token)
    Facilitator->>Stellar: submit payment tx
    Stellar-->>Facilitator: confirmed
    Facilitator-->>Server: settled
    Server-->>Client: 200 OK + response body
```

### HTTP 402 Challenge / Resolution Handshake

A detailed view of the full HTTP-level exchange between the client and server during an x402 micropayment, including the challenge/response cycle and on-chain settlement:

```mermaid
sequenceDiagram
    participant Client as Client<br/>(marcFetch)
    participant Server as Server<br/>(marcPaywall)
    participant Facilitator as Facilitator<br/>(@x402/stellar)
    participant Stellar as Stellar Network

    Client->>Server: HTTP POST /api/resource<br/>(no payment header)
    Server-->>Client: 402 Payment Required<br/>WWW-Authenticate: x402<br/>{ price, token, payTo, network }

    Note over Client: Parse payment requirements<br/>price · token · payTo · network

    Client->>Client: Build Stellar payment transaction<br/>Sign transaction → XDR envelope

    Client->>Server: HTTP POST /api/resource<br/>X-PAYMENT: <signed XDR>
    Server->>Facilitator: verify(signedXDR, paymentRequirements)
    Facilitator->>Stellar: Submit payment transaction
    Stellar-->>Facilitator: Transaction confirmed (ledger close)
    Facilitator-->>Server: Settlement confirmation (txHash)
    Server-->>Client: 200 OK<br/>{ response body }
```

---

## Layer Sequence Diagrams

End-to-end sequence diagrams for each of the three protocol layers, showing how the Buyer, Seller, Soroban smart contracts, and x402 Facilitators interact.

### Layer 1: Identity Registration & Deregistration

```mermaid
sequenceDiagram
    autonumber
    participant Agent as Agent<br/>(Buyer / Seller)
    participant Identity as agent-identity<br/>contract
    participant RPC as Soroban RPC

    Note over Agent,RPC: Registration
    Agent->>RPC: simulateTransaction(register(owner, uri))
    RPC-->>Agent: simulation result (footprint, fees)
    Agent->>Agent: sign transaction envelope
    Agent->>RPC: sendTransaction(signed register)
    RPC->>Identity: register(owner, uri)
    Identity->>Identity: assert owner not already registered
    Identity->>Identity: store address → agentId, uri, active = true
    Identity-->>RPC: agentId
    RPC-->>Agent: tx hash + agentId

    Note over Agent,RPC: Lookup
    Agent->>RPC: simulateTransaction(agentOf(address))
    RPC->>Identity: agentOf(address)
    Identity-->>RPC: agentId or null
    RPC-->>Agent: agentId or null

    Note over Agent,RPC: Deregistration
    Agent->>RPC: sendTransaction(deregister(owner))
    RPC->>Identity: deregister(owner)
    Identity->>Identity: assert caller == owner
    Identity->>Identity: set active = false
    Identity-->>RPC: ok
    RPC-->>Agent: tx hash
```

### Layer 2: Job Escrow Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Buyer as Buyer Agent<br/>(client)
    participant Commerce as agentic-commerce<br/>contract
    participant Token as MUSD Token<br/>(SAC)
    participant Seller as Seller Agent<br/>(provider)
    participant Evaluator as Evaluator

    Note over Buyer,Evaluator: Funded
    Buyer->>Token: approve(commerce, budget)
    Buyer->>Commerce: create_job(provider, evaluator, token, budget, desc)
    Commerce->>Token: transfer(buyer → escrow)
    Commerce-->>Buyer: jobId (status = Funded)

    Note over Buyer,Evaluator: Submitted
    Seller->>Commerce: submit(jobId, deliverableUri)
    Commerce->>Commerce: assert status == Funded
    Commerce-->>Seller: ok (status = Submitted)

    alt Completed
        Buyer->>Commerce: complete(jobId)
        Commerce->>Commerce: assert status == Submitted
        Commerce->>Token: transfer(escrow → seller 99%)
        Commerce->>Token: transfer(escrow → treasury 1%)
        Commerce-->>Buyer: ok (status = Completed)
    else Cancelled
        Buyer->>Commerce: cancel(jobId)
        Commerce->>Commerce: assert status == Funded
        Commerce->>Token: transfer(escrow → buyer, full refund)
        Commerce-->>Buyer: ok (status = Cancelled)
    else Disputed
        Buyer->>Commerce: dispute(jobId)
        Commerce->>Commerce: assert status == Submitted
        Commerce-->>Buyer: ok (status = Disputed)
        Evaluator->>Commerce: resolve(jobId, outcome)
        Commerce->>Token: transfer(escrow → seller or buyer)
        Commerce-->>Evaluator: ok (status = Resolved)
    end
```

### Layer 3: HTTP 402 Micropayment Flow

```mermaid
sequenceDiagram
    autonumber
    participant Client as Client<br/>(marcFetch)
    participant Server as Server<br/>(marcPaywall)
    participant Facilitator as Facilitator<br/>(@x402/stellar)
    participant Stellar as Stellar Network

    Note over Client,Stellar: Request
    Client->>Server: GET /api/resource (no payment header)

    Note over Client,Stellar: 402 Challenge
    Server-->>Client: 402 Payment Required<br/>{ price, token, payTo, network }

    Note over Client,Stellar: Sign
    Client->>Client: build Stellar payment transaction
    Client->>Client: sign transaction → XDR envelope

    Note over Client,Stellar: X-Payment
    Client->>Server: GET /api/resource<br/>X-PAYMENT: <signed XDR>
    Server->>Facilitator: verify(signedXDR, paymentRequirements)
    Facilitator->>Stellar: submit payment transaction
    Stellar-->>Facilitator: confirmed (ledger close)
    Facilitator-->>Server: settlement confirmation (txHash)

    Note over Client,Stellar: 200 OK
    Server-->>Client: 200 OK<br/>{ response body }
```

---

## Dependency Graph

```mermaid
graph TD
    subgraph Contracts["Rust Contracts (Soroban / WASM)"]
        AI["agent-identity\nsoroban-sdk 27"]
        AC["agentic-commerce\nsoroban-sdk 27"]
        AC -->|reads| AI
    end

    subgraph SDK["TypeScript SDK (marc-stellar-sdk)"]
        IC["IdentityClient"]
        CC["CommerceClient"]
        MF2["marcFetch"]
        MP2["marcPaywall"]
        IC -->|"@stellar/stellar-sdk"| RPC2[Soroban RPC]
        CC -->|"@stellar/stellar-sdk"| RPC2
        MF2 -->|"@x402/stellar"| Fac[Facilitator]
        MP2 -->|"@x402/stellar"| Fac
    end

    subgraph Consumers["Apps & Agents"]
        Dashboard -->|REST| SDK
        BuyerAgent -->|import| SDK
        SellerAgents -->|import| SDK
    end
```

---

## Data Model

```mermaid
erDiagram
    AGENT {
        u64 id
        address owner
        string uri
        bool active
    }

    JOB {
        u64 id
        address client
        address provider
        address evaluator
        address token
        i128 budget
        string description
        string status
        string deliverable_uri
    }

    AGENT ||--o{ JOB : "provides"
    AGENT ||--o{ JOB : "evaluates"
    AGENT ||--o{ JOB : "creates"
```

---

## Key Addresses (Testnet)

| Contract         | Address                                                    |
| ---------------- | ---------------------------------------------------------- |
| Agent Identity   | `CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5` |
| Agentic Commerce | `CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE` |
| USDC (SAC)       | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

---

## Capability Tag Taxonomy

Agent manifests standardize capability metadata using an approved taxonomy (Issue #597) rather than arbitrary free-form strings. This allows buyer agents and discovery clients to reliably query and match service providers by capability.

The canonical taxonomy is defined in `agents/shared.ts` as `APPROVED_TAGS`:

```typescript
export const APPROVED_TAGS = [
  "webdev",
  "copywriting",
  "research",
  "naming",
  "translation",
  "data-analysis",
  "seo",
  "design",
] as const;
```

### Approved Taxonomy Reference

| Tag | Domain | Description | Typical Tasks |
| --- | ------ | ----------- | ------------- |
| `webdev` | Development | Web development, HTML/CSS generation, frontend UI | `build website`, `create landing page`, `build html page` |
| `copywriting` | Content | Marketing copy, headlines, body sections, CTAs | `write copy`, `write website copy`, `write tagline` |
| `research` | Intelligence | Topic investigation, market research, fact finding | `research`, `summarise topic`, `market research` |
| `naming` | Branding | Creative brand, company, and product naming | `generate names`, `brand naming`, `product naming` |
| `translation` | Language | Cross-language translation, localization | `translate document`, `localize copy` |
| `data-analysis` | Analytics | Quantitative summaries, data extraction, analysis | `analyze data`, `statistical report` |
| `seo` | Marketing | Keyword research, metadata generation, optimization | `seo audit`, `optimize keywords` |
| `design` | Creative | UI layout, CSS design specifications, styling | `design mockup`, `style guide` |

### Registry Validation

The agent registry (`agents/registry/server.ts`) enforces taxonomy compliance via `validateTags(tags: string[])`:
- Rejects or warns on unknown tags during heartbeat manifest verification.
- Normalized to lowercase trimmed strings.
- Filters queries on `GET /agents?tags=webdev,design` strictly against active provider capabilities.

