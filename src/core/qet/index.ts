/** QElectroTech (.qet / .elmt) compatibility layer — public API. */
export { parseElmt, parseElmtNode, serializeElmt, defModified, defSignature, primsBBox, parseStyle, styleToString, dockElmtOffset, QET_VERSION, TERMINAL_SIZE } from "./elmt";
export type { ParseElmtOptions } from "./elmt";
export {
  importQet,
  exportQet,
  validateQet,
  qetAutoPath,
  normalizePath,
  qetVersionNumber,
  junctionDef,
  QET_MARGIN,
  JUNCTION_DEF_PATH,
  JUNCTION_DEF_NAME,
  JUNCTION_MARKER,
} from "./project";
export {
  parseTitleBlockTemplate,
  parseTitleBlockNode,
  serializeTitleBlockTemplate,
  titleBlockModified,
  titleBlockHeight,
  titleBlockColumnWidths,
  parseRows,
  parseCols,
  TitleBlockParseError,
} from "./titleblock";
export { parseXml, serializeXml, QetXmlError } from "./xml";
