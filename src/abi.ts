// ABIs. Memo ABI fetched from the VERIFIED predeploy on ArcScan (Blockscout
// /api?module=contract&action=getabi&address=0x5294...505) — not guessed.
import { parseAbi } from "viem";

export const memoAbi = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
  "function memoIndex() view returns (uint256)",
  "event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)",
  "error MemoFailed(bytes returnData)",
]);

// Multicall3From — ABI taken from the verified predeploy on ArcScan.
export const multicall3FromAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) returns ((bool success, bytes returnData)[])",
]);

export const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
