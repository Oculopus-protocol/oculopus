// Shared demo dataset for the no-node (Vercel) view. Explore and Graph both read this
// so the leaderboard and the counterparty graph show the same agents. A live node
// overrides it entirely with /directory + /buyers.
window.OC_DEMO = {
  providers: [
    { address: "0x9aec413ff42858eaf080af688b9a858396af1174", agentId: 851356, name: "atlas-embed",  category: "embedding",     categoryLabel: "Embeddings",             score: 46.4, receipts: 9,  pos: 6.2, neg: 1.1, uniq: 5, rails: { onchain: 6, x402: 3, job: 0 }, raw: 92.0,  days: 12 },
    { address: "0x2f81ba0d7cc4e9a5301bb6f2a7e4419c8d0a5b3e", agentId: 712004, name: "orion-rerank",  category: "rerank",        categoryLabel: "Reranking",              score: 52.8, receipts: 14, pos: 9.4, neg: 0.8, uniq: 9, rails: { onchain: 8, x402: 4, job: 2 }, raw: 95.5,  days: 21 },
    { address: "0xd18b06f4a3e952c7018df6b25a940c3e7f2158ab", agentId: 745210, name: "pyxis-ocr",     category: "ocr",           categoryLabel: "OCR & document parsing", score: 44.7, receipts: 11, pos: 7.1, neg: 1.4, uniq: 7, rails: { onchain: 7, x402: 3, job: 1 }, raw: 93.4,  days: 9  },
    { address: "0xb47d9e1f6c05a2384fd1e9b7c2a6580d3e17f4a9", agentId: 733918, name: "helix-ocr",     category: "ocr",           categoryLabel: "OCR & document parsing", score: 41.9, receipts: 8,  pos: 5.6, neg: 1.7, uniq: 6, rails: { onchain: 4, x402: 4, job: 0 }, raw: 90.2,  days: 15 },
    { address: "0xc718d7f85eaf0b817f6451ae5ac2aff55d5939d0", agentId: 851357, name: "nimbus-embed",  category: "embedding",     categoryLabel: "Embeddings",             score: 37.5, receipts: 5,  pos: 3.4, neg: 0.6, uniq: 3, rails: { onchain: 5, x402: 0, job: 0 }, raw: 100.0, days: 7  },
    { address: "0x130c93bffc2e6285fd474438d404331b9103c741", agentId: 851358, name: "quartz-embed",  category: "embedding",     categoryLabel: "Embeddings",             score: 37.5, receipts: 5,  pos: 3.2, neg: 0.9, uniq: 4, rails: { onchain: 3, x402: 2, job: 0 }, raw: 100.0, days: 8  },
    { address: "0x7e30c58a91bd46f2e8c7015a3d9b62f4081ca7d6", agentId: 690117, name: "corvus-llm",    category: "llm-inference", categoryLabel: "LLM inference",          score: 33.2, receipts: 6,  pos: 3.9, neg: 2.0, uniq: 4, rails: { onchain: 2, x402: 4, job: 0 }, raw: 84.0,  days: 18 },
    { address: "0x5a92f7013e8cb4d6a72f19e05c83bd47206ef1c8", agentId: 801446, name: "lyra-embed",    category: "embedding",     categoryLabel: "Embeddings",             score: 29.6, receipts: 4,  pos: 2.1, neg: 1.3, uniq: 2, rails: { onchain: 1, x402: 3, job: 0 }, raw: 97.0,  days: 5  },
    { address: "0x6b4c3a762e01165f78ff75743d3f0decfed45dda", agentId: 600522, name: "vega-llm",      category: "llm-inference", categoryLabel: "LLM inference",          score: 25.0, receipts: 0,  pos: 0,   neg: 0,   uniq: 0, rails: { onchain: 0, x402: 0, job: 0 }, raw: 88.0,  days: 3  },
    { address: "0x3c6a1de85f207b94ca3e08d716f5b420e9d3a06f", agentId: 822975, name: "mensa-rerank",  category: "rerank",        categoryLabel: "Reranking",              score: 25.0, receipts: 1,  pos: 0.7, neg: 0,   uniq: 1, rails: { onchain: 1, x402: 0, job: 0 }, raw: 99.0,  days: 2  },
  ],
  buyers: [
    { address: "0x8a3f1c9d2e5b47061af8c3d902e4b1576a0d9c11", name: "buyer-8a3f", score: 41.2, receipts: 12, pos: 8.0, neg: 0.4, uniq: 6 },
    { address: "0x4d71e0a8c3f52b9146de0a7c81f3b2059e6d4a70", name: "buyer-4d71", score: 34.9, receipts: 7,  pos: 4.6, neg: 0.9, uniq: 4 },
    { address: "0xf20b5a1e9c74d3862ba0f5e13c8749d602e1b3af", name: "buyer-f20b", score: 28.3, receipts: 3,  pos: 1.8, neg: 0.7, uniq: 3 },
    { address: "0x1c86d4b70e29f5a3418bc0e6d95f27401ab3e9d2", name: "buyer-1c86", score: 25.6, receipts: 2,  pos: 1.0, neg: 0.5, uniq: 2 },
  ],
};
