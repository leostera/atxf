/**
 * The ATXF format versions this library implements. The package has its own version; these are the versions of
 * the format (SPEC §16) it reads and writes.
 */

/** The format version written in the headers of transcripts this library produces. */
export const ATXF_VERSION = "0.1";

/** Every format version this library accepts. */
export const ATXF_VERSIONS = [ATXF_VERSION] as const;

export type AtxfVersion = (typeof ATXF_VERSIONS)[number];
