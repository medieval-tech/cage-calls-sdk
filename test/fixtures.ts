import { encodeByteArray, encodeShortString, encodeU256 } from "../src/codecs.js";
import type { Address, RelicMetadata } from "../src/types.js";

export const metadataFixture = (tokenId = 1n): RelicMetadata => ({
  definitionId: tokenId,
  seasonId: 1n,
  fightId: 10n,
  fighterId: 1n,
  opponentId: 2n,
  sponsor: "",
  relicIndex: 1,
  fightTimestamp: 1_700_000_000n,
  mediaUri: "ipfs-image",
  mediaType: 0,
  category: 0,
  moveType: "strike",
  moveName: "Uppercut",
  tags: 0n,
  intent: 0,
  effectVector: 1,
  targetZone: 0,
  power: 8,
  speed: 7,
  control: 6,
  risk: 5,
  complexity: 4,
  versatility: 3,
  comboFlags: 0,
  linkableToTags: 0n,
  requiresTagsBefore: 0n,
  rarity: 3,
  relicType: "offense",
  style: "boxing",
  weightClass: "welterweight",
});

export function encodeMetadata(value: RelicMetadata): string[] {
  return [
    ...encodeU256(value.definitionId), ...encodeU256(value.seasonId), ...encodeU256(value.fightId),
    ...encodeU256(value.fighterId), ...encodeU256(value.opponentId), encodeShortString(value.sponsor),
    String(value.relicIndex), String(value.fightTimestamp), encodeShortString(value.mediaUri),
    String(value.mediaType), String(value.category), encodeShortString(value.moveType), encodeShortString(value.moveName),
    ...encodeU256(value.tags), String(value.intent), String(value.effectVector), String(value.targetZone),
    String(value.power), String(value.speed), String(value.control), String(value.risk), String(value.complexity),
    String(value.versatility), String(value.comboFlags), ...encodeU256(value.linkableToTags),
    ...encodeU256(value.requiresTagsBefore), String(value.rarity), encodeShortString(value.relicType),
    encodeShortString(value.style), encodeShortString(value.weightClass),
  ];
}

export function encodeRelicRow(tokenId: bigint, owner: Address, tokenUri = `ipfs://metadata-${tokenId}`): string[] {
  const metadata = metadataFixture(tokenId);
  return [
    ...encodeU256(tokenId), owner,
    ...encodeU256(metadata.definitionId), ...encodeU256(1n), ...encodeMetadata(metadata),
    ...encodeByteArray("Fight Night"), ...encodeByteArray(tokenUri),
  ];
}

export function encodeRelicRows(rows: Array<{ tokenId: bigint; owner: Address; tokenUri?: string }>): string[] {
  return [rows.length.toString(), ...rows.flatMap((row) => encodeRelicRow(row.tokenId, row.owner, row.tokenUri))];
}

export function encodeOwnedPage(rows: Array<{ tokenId: bigint; owner: Address; tokenUri?: string }>, cursor = 0n): string[] {
  return [...encodeRelicRows(rows), ...encodeU256(cursor)];
}

export const toriiToken = (tokenId: bigint, contractAddress: Address, complete = true) => ({
  __typename: "ERC721__Token",
  tokenId: tokenId.toString(),
  contractAddress,
  metadataName: complete ? `Relic #${tokenId}` : null,
  metadata: complete ? JSON.stringify({
    name: `Relic #${tokenId}`,
    image: `ipfs://image-${tokenId}`,
    attributes: [{ trait_type: "Power", value: 8 }],
  }) : null,
  metadataAttributes: complete ? JSON.stringify([{ trait_type: "Power", value: 8 }]) : null,
});
