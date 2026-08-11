// @ts-check

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../core/zip.mjs';
import { createPdf } from './lib/pdf-writer.mjs';
import { createZip } from './lib/zip-writer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examples = resolve(root, 'examples');
const fixtures = resolve(root, 'tests', 'fixtures');
await mkdir(examples, { recursive: true });
await mkdir(fixtures, { recursive: true });

const xml = (value) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`;
const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const pNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const aNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const rNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** @param {number} value */
function be32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

/** @param {string} type @param {Buffer} data */
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
}

function samplePng(unsafe) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.from([
    0, 20, 28, 40, 20, 28, 40,
    0, 220, 224, 228, 220, 224, 228,
  ]);
  const chunks = [pngChunk('IHDR', ihdr)];
  if (unsafe) chunks.push(pngChunk('tEXt', Buffer.from('Author\0Confidential Photo Desk', 'latin1')));
  chunks.push(pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([signature, ...chunks]);
}

function theme() {
  return xml(`<a:theme xmlns:a="${aNs}" name="Safe to Send"><a:themeElements><a:clrScheme name="Safe to Send"><a:dk1><a:sysClr val="windowText" lastClr="171717"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="243447"/></a:dk2><a:lt2><a:srgbClr val="F4F2EC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="C2410C"/></a:accent2><a:accent3><a:srgbClr val="15803D"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="0E7490"/></a:accent5><a:accent6><a:srgbClr val="A16207"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Safe to Send"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Safe to Send"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`);
}

function shape(id, name, text, x, y, width, height, hidden = false) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"${hidden ? ' hidden="1"' : ''}/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}

function picture() {
  return `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Cropped photo" descr="Source photo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/><a:srcRect l="12000" r="18000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="685800" y="3657600"/><a:ext cx="2743200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function slide(number, unsafe, hidden = false) {
  const objects = [shape(2, 'Title', hidden ? 'Unannounced acquisition: Northstar' : (unsafe ? 'Unsafe sharing copy' : 'Reviewed distribution copy'), 685800, 548640, 10515600, 914400)];
  if (unsafe && number === 1) {
    objects.push(shape(3, 'Hidden credentials', 'api_key=demo_secret_123456789', 685800, 1828800, 6400800, 548640, true));
    objects.push(shape(4, 'Off-slide note', 'private.person@example.com', 13000000, 2743200, 3657600, 548640));
    objects.push(picture());
  }
  return xml(`<p:sld xmlns:a="${aNs}" xmlns:r="${rNs}" xmlns:p="${pNs}"${hidden ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${objects.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
}

function notesSlide() {
  return xml(`<p:notes xmlns:a="${aNs}" xmlns:r="${rNs}" xmlns:p="${pNs}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Text"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Do not share. Customer margin is 41%. Contact private.person@example.com.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
}

function notesMaster() {
  return xml(`<p:notesMaster xmlns:a="${aNs}" xmlns:r="${rNs}" xmlns:p="${pNs}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:hf/><p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle></p:notesMaster>`);
}

function baseEntries(unsafe) {
  const slideCount = unsafe ? 2 : 1;
  const contentTypeOverrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ...Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
  ];
  if (unsafe) contentTypeOverrides.push(
    '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>',
    '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>',
    '<Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/>',
    '<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/>',
    '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>',
  );
  const contentTypes = xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>${contentTypeOverrides.join('')}</Types>`);
  const rootRels = xml(`<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${officeRel}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${officeRel}/extended-properties" Target="docProps/app.xml"/>${unsafe ? `<Relationship Id="rId4" Type="${officeRel}/custom-properties" Target="docProps/custom.xml"/>` : ''}</Relationships>`);
  const core = xml(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${unsafe ? 'Internal review copy' : 'Reviewed distribution copy'}</dc:title><dc:creator>${unsafe ? 'Internal Strategy Team' : ''}</dc:creator><cp:lastModifiedBy>${unsafe ? 'External Counsel' : ''}</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-08-10T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-08-10T00:00:00Z</dcterms:modified></cp:coreProperties>`);
  const app = xml(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Safe to Send fixture generator</Application><Slides>${slideCount}</Slides><Notes>${unsafe ? 1 : 0}</Notes><HiddenSlides>${unsafe ? 1 : 0}</HiddenSlides><Manager>${unsafe ? 'M. Reviewer' : ''}</Manager><Company>${unsafe ? 'Example Holdings' : ''}</Company></Properties>`);
  const slideIds = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 4}"/>`).join('');
  const presentation = xml(`<p:presentation xmlns:a="${aNs}" xmlns:r="${rNs}" xmlns:p="${pNs}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${unsafe ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' : ''}<p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`);
  const presentationRels = xml(`<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${officeRel}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${unsafe ? `<Relationship Id="rId2" Type="${officeRel}/notesMaster" Target="notesMasters/notesMaster1.xml"/><Relationship Id="rId3" Type="${officeRel}/commentAuthors" Target="commentAuthors.xml"/>` : '<Relationship Id="rId2" Type="'+officeRel+'/theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="'+officeRel+'/tableStyles" Target="tableStyles.xml"/>'}${Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 4}" Type="${officeRel}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`);
  const master = xml(`<p:sldMaster xmlns:a="${aNs}" xmlns:r="${rNs}" xmlns:p="${pNs}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`);
  const masterRels = xml(`<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${officeRel}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${officeRel}/theme" Target="../theme/theme1.xml"/></Relationships>`);
  const layout = xml(`<p:sldLayout xmlns:a="${aNs}" xmlns:r="${rNs}" xmlns:p="${pNs}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  const layoutRels = xml(`<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${officeRel}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: masterRels },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: layoutRels },
    { name: 'ppt/theme/theme1.xml', data: theme() },
    { name: 'ppt/tableStyles.xml', data: xml(`<a:tblStyleLst xmlns:a="${aNs}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`) },
    { name: 'ppt/slides/slide1.xml', data: slide(1, unsafe, false) },
  ];
  const slide1Rels = [`<Relationship Id="rId1" Type="${officeRel}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
  if (unsafe) {
    slide1Rels.push(
      `<Relationship Id="rId2" Type="${officeRel}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>`,
      `<Relationship Id="rId3" Type="${officeRel}/image" Target="../media/image1.png"/>`,
      `<Relationship Id="rId4" Type="${officeRel}/comments" Target="../comments/comment1.xml"/>`,
      `<Relationship Id="rId5" Type="${officeRel}/hyperlink" Target="https://portal.example.test/share?token=private_share_token_123456789" TargetMode="External"/>`,
      `<Relationship Id="rId6" Type="${officeRel}/oleObject" Target="file:///Users/alice/Finance/Q4-model.xlsx" TargetMode="External"/>`,
    );
  }
  entries.push({ name: 'ppt/slides/_rels/slide1.xml.rels', data: xml(`<Relationships xmlns="${relNs}">${slide1Rels.join('')}</Relationships>`) });
  if (unsafe) {
    entries.push(
      { name: 'ppt/slides/slide2.xml', data: slide(2, true, true) },
      { name: 'ppt/slides/_rels/slide2.xml.rels', data: xml(`<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${officeRel}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`) },
      { name: 'ppt/notesMasters/notesMaster1.xml', data: notesMaster() },
      { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: xml(`<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${officeRel}/theme" Target="../theme/theme1.xml"/></Relationships>`) },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: notesSlide() },
      { name: 'ppt/notesSlides/_rels/notesSlide1.xml.rels', data: xml(`<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${officeRel}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${officeRel}/slide" Target="../slides/slide1.xml"/></Relationships>`) },
      { name: 'ppt/commentAuthors.xml', data: xml(`<p:cmAuthorLst xmlns:p="${pNs}"><p:cmAuthor id="0" name="Internal Reviewer" initials="IR" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`) },
      { name: 'ppt/comments/comment1.xml', data: xml(`<p:cmLst xmlns:p="${pNs}"><p:cm authorId="0" dt="2026-08-10T00:00:00Z" idx="1"><p:pos x="0" y="0"/><p:text>Remove before external circulation. Draft valuation is confidential.</p:text></p:cm></p:cmLst>`) },
      { name: 'ppt/media/image1.png', data: samplePng(true), compress: false },
      { name: 'ppt/embeddings/embeddedWorkbook1.xlsx', data: 'Synthetic embedded workbook fixture. Internal forecast: 4200000.' },
      { name: 'customXml/item1.xml', data: xml('<internal><project>Project Cobalt</project><password>demo_secret_123456789</password></internal>') },
      { name: 'docProps/custom.xml', data: xml('<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="InternalProject"><vt:lpwstr>Project Cobalt</vt:lpwstr></property></Properties>') },
    );
  }
  return entries;
}

const outputs = [
  ['clean-sample.pdf', createPdf({ unsafe: false })],
  ['unsafe-sample.pdf', createPdf({ unsafe: true })],
  ['clean-sample.pptx', createZip(baseEntries(false))],
  ['unsafe-sample.pptx', createZip(baseEntries(true))],
];

for (const [name, data] of outputs) {
  await writeFile(resolve(examples, name), data);
  await writeFile(resolve(fixtures, name), data);
}

console.log(`Generated ${outputs.length} deterministic fixtures in examples/ and tests/fixtures/.`);
