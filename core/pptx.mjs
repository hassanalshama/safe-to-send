// @ts-check

import { inspectImageMetadata } from './image-metadata.mjs';
import { finding } from './model.mjs';
import { detectSensitiveText } from './patterns.mjs';
import { openZip, ZipError } from './zip.mjs';
import { compact, extensionOf, formatBytes } from './util.mjs';
import { extractTextRuns, firstText, parseAttributes, parseRelationships, relationshipsPart, resolvePart, stripXml, tags } from './xml.mjs';

const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_SCAN_BYTES = 64 * 1024 * 1024;

/** @param {string} value */
function truthyXml(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());
}

/** @param {string} value */
function falseyXml(value) {
  return ['0', 'false', 'off', 'no'].includes(String(value || '').toLowerCase());
}

/** @param {string} value */
function safeTarget(value) {
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    url.username = '';
    url.password = '';
    url.search = keys.length ? `?${keys.map((key) => `${encodeURIComponent(key)}=…`).join('&')}` : '';
    url.hash = '';
    return compact(url.toString(), 220);
  } catch {
    return compact(value, 220);
  }
}

/** @param {string} text @param {string} location @param {ReturnType<typeof finding>[]} findings */
function addSensitiveFindings(text, location, findings) {
  for (const match of detectSensitiveText(text)) {
    findings.push(finding({
      ruleId: `content.${match.ruleId}`,
      severity: match.severity,
      confidence: 'high',
      title: `${match.label} found in concealed content`,
      summary: 'A private or credential-like value appears in content that may not be obvious in the normal slide view.',
      evidence: match.evidence,
      location,
      remediation: match.severity === 'high'
        ? 'Revoke or rotate the credential, remove the concealed content, save a fresh copy, and scan it again.'
        : 'Confirm the value is intended for the recipient or remove it before sharing.',
      tags: ['sensitive-content', 'hidden-content'],
    }));
  }
}

/** @param {string} xml */
function commentText(xml) {
  const values = [];
  for (const item of tags(xml, 'text')) {
    const text = compact(stripXml(item.inner), 2000);
    if (text) values.push(text);
  }
  const runs = extractTextRuns(xml);
  if (runs && !values.includes(runs)) values.push(runs);
  return compact(values.join(' | '), 4000);
}

/** @param {string} xml */
function shapeBlocks(xml) {
  const blocks = [];
  const expression = /<p:(sp|pic|graphicFrame|cxnSp)\b[\s\S]*?<\/p:\1\s*>/gi;
  for (const match of xml.matchAll(expression)) blocks.push({ type: match[1], xml: match[0] });
  return blocks;
}

/** @param {string} xml */
function shapeDetails(xml) {
  const propertyMatch = xml.match(/<p:cNvPr\b([^>]*)\/?\s*>/i);
  const properties = parseAttributes(propertyMatch?.[1] || '');
  const transformMatch = xml.match(/<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm\s*>/i);
  const transformXml = transformMatch?.[1] || xml;
  const off = parseAttributes(transformXml.match(/<a:off\b([^>]*)\/?\s*>/i)?.[1] || '');
  const ext = parseAttributes(transformXml.match(/<a:ext\b([^>]*)\/?\s*>/i)?.[1] || '');
  const sourceRect = parseAttributes(xml.match(/<a:srcRect\b([^>]*)\/?\s*>/i)?.[1] || '');
  const blip = parseAttributes(xml.match(/<a:blip\b([^>]*)\/?\s*>/i)?.[1] || '');
  return {
    name: properties.name || `Object ${properties.id || ''}`.trim(),
    hidden: truthyXml(properties.hidden),
    description: properties.descr || '',
    title: properties.title || '',
    text: compact(extractTextRuns(xml), 1000),
    geometry: {
      x: Number(off.x), y: Number(off.y), width: Number(ext.cx), height: Number(ext.cy),
    },
    crop: {
      left: Number(sourceRect.l || 0), top: Number(sourceRect.t || 0), right: Number(sourceRect.r || 0), bottom: Number(sourceRect.b || 0),
    },
    relationshipId: blip['r:embed'] || blip.embed || '',
  };
}

/** @param {{x:number,y:number,width:number,height:number}} box @param {{width:number,height:number}} slide */
function entirelyOffSlide(box, slide) {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return false;
  if (box.width <= 0 || box.height <= 0) return false;
  return box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= slide.width || box.y >= slide.height;
}

/** @param {{left:number,top:number,right:number,bottom:number}} crop */
function hasCrop(crop) {
  return Object.values(crop).some((value) => Number.isFinite(value) && value !== 0);
}

/** @param {string} name */
function slideNumber(name) {
  return Number(name.match(/slide(\d+)\.xml$/i)?.[1] || Number.MAX_SAFE_INTEGER);
}

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {{findings: ReturnType<typeof finding>[], coverage: {complete:boolean, checks:string[], limitations:string[], details:Record<string,unknown>}}}
 */
export function scanPptx(bytes, filename = 'presentation.pptx') {
  const findings = [];
  const checks = [];
  const limitations = [];
  const details = {};
  let archive;
  try {
    archive = openZip(bytes, {
      maxEntries: 20_000,
      maxEntryBytes: 128 * 1024 * 1024,
      maxTotalBytes: 768 * 1024 * 1024,
      maxCompressionRatio: 2_000,
      verifyCrc: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push(finding({
      ruleId: 'pptx.package.invalid', severity: 'high', title: 'PowerPoint package could not be opened',
      summary: 'The file is not a readable Office Open XML package or it violates a scanner safety limit.', evidence: message,
      remediation: 'Verify the file source, open it in PowerPoint, save a new copy, and scan the new file.', tags: ['format', 'coverage'],
    }));
    return { findings, coverage: { complete: false, checks: ['Office package structure'], limitations: [message], details } };
  }

  checks.push('Office package structure, integrity, and entry safety');
  details.packageEntries = archive.entries.length;
  details.zip64 = archive.zip64;
  for (const diagnostic of archive.diagnostics.slice(0, 30)) {
    const severity = diagnostic.code === 'UNSAFE_PATH' ? 'high' : 'medium';
    findings.push(finding({
      ruleId: `pptx.package.${diagnostic.code.toLowerCase().replaceAll('_', '-')}`,
      severity,
      title: diagnostic.code === 'UNSAFE_PATH' ? 'Unsafe path found inside the presentation package' : 'Unusual Office package structure detected',
      summary: diagnostic.message,
      evidence: diagnostic.entry || undefined,
      remediation: 'Recreate the presentation from a trusted source before sharing it.', tags: ['package', 'integrity'],
    }));
  }
  const encryptedEntries = archive.entries.filter((entry) => entry.encrypted);
  if (encryptedEntries.length) {
    findings.push(finding({
      ruleId: 'pptx.package.encrypted-entry', severity: 'high', title: 'Encrypted package entries cannot be inspected',
      summary: `${encryptedEntries.length} internal file${encryptedEntries.length === 1 ? '' : 's'} are encrypted.`,
      evidence: encryptedEntries.slice(0, 8).map((entry) => entry.name).join(', '),
      remediation: 'Create a decrypted copy in a controlled environment and scan that copy before sharing.', tags: ['coverage', 'encryption'],
    }));
    limitations.push('Encrypted package entries were not inspected.');
  }

  if (!archive.has('[Content_Types].xml') || !archive.has('ppt/presentation.xml')) {
    findings.push(finding({
      ruleId: 'pptx.package.signature', severity: 'high', title: 'File is not a valid PowerPoint Open XML presentation',
      summary: 'Required PowerPoint package parts are missing.',
      remediation: 'Verify the extension and save a new .pptx or .pptm file from PowerPoint.', tags: ['format'],
    }));
    return { findings, coverage: { complete: false, checks, limitations: ['Required PowerPoint package parts are missing.'], details } };
  }

  const readText = (name, optional = false) => {
    const entry = archive.get(name);
    if (!entry) return '';
    if (entry.uncompressedSize > MAX_XML_BYTES) {
      limitations.push(`${name} exceeds the XML inspection limit.`);
      return '';
    }
    try { return entry.text(); }
    catch (error) {
      if (!optional) limitations.push(`${name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  };

  const contentTypes = readText('[Content_Types].xml');
  const extension = extensionOf(filename);
  const macroParts = archive.entries.filter((entry) => /(?:^|\/)vbaProject\.bin$/i.test(entry.name));
  const macroEnabled = macroParts.length > 0 || /presentation\.macroEnabled\.main\+xml/i.test(contentTypes);
  checks.push('Macros and executable content');
  if (macroEnabled) {
    findings.push(finding({
      ruleId: 'pptx.macro', severity: 'high', title: 'VBA macro content detected',
      summary: 'The presentation contains executable Visual Basic for Applications content.',
      evidence: macroParts.length ? macroParts.map((entry) => entry.name).join(', ') : 'Macro-enabled presentation content type',
      remediation: 'Remove macros unless they are explicitly required and trusted. Share a reviewed .pptx copy rather than a macro-enabled file.',
      tags: ['macro', 'active-content'],
    }));
    if (extension === 'pptx') {
      findings.push(finding({
        ruleId: 'pptx.macro.extension-mismatch', severity: 'high', title: 'Macro content does not match the .pptx extension',
        summary: 'Executable VBA content was found in a file named as a non-macro PowerPoint presentation.',
        remediation: 'Treat the file as suspicious. Recreate it from a trusted source.', tags: ['macro', 'format'],
      }));
    }
  }

  checks.push('Author, company, and custom document properties');
  const core = readText('docProps/core.xml', true);
  const app = readText('docProps/app.xml', true);
  const custom = readText('docProps/custom.xml', true);
  const metadata = {
    creator: firstText(core, 'creator'),
    lastModifiedBy: firstText(core, 'lastModifiedBy'),
    title: firstText(core, 'title'),
    subject: firstText(core, 'subject'),
    keywords: firstText(core, 'keywords'),
    company: firstText(app, 'Company'),
    manager: firstText(app, 'Manager'),
    template: firstText(app, 'Template'),
    application: firstText(app, 'Application'),
  };
  const personal = Object.entries(metadata).filter(([key, value]) => value && ['creator', 'lastModifiedBy', 'company', 'manager', 'template'].includes(key));
  if (personal.length) {
    findings.push(finding({
      ruleId: 'pptx.metadata.personal', severity: 'medium', title: 'Authoring metadata remains in the presentation',
      summary: 'Recipients can inspect author, company, editor, or template properties stored in the file.',
      evidence: personal.slice(0, 8).map(([key, value]) => `${key}: ${value}`).join('; '),
      remediation: 'Use PowerPoint Document Inspector to remove personal information, save a new copy, and scan it again.',
      tags: ['metadata', 'identity'], data: { fields: metadata },
    }));
  }
  if (custom) {
    const properties = tags(custom, 'property').map(({ attributes, inner }) => ({
      name: attributes.name || 'Custom property', value: compact(stripXml(inner), 300),
    })).filter((item) => item.value);
    if (properties.length) {
      findings.push(finding({
        ruleId: 'pptx.metadata.custom', severity: 'medium', title: 'Custom document properties detected',
        summary: 'Custom properties can contain internal workflow, classification, or identifying information.',
        evidence: properties.slice(0, 10).map((item) => `${item.name}: ${item.value}`).join('; '),
        remediation: 'Review and remove custom properties that the recipient does not need.', tags: ['metadata'],
      }));
      addSensitiveFindings(properties.map((item) => `${item.name}: ${item.value}`).join('\n'), 'Custom document properties', findings);
    }
  }

  const presentationXml = readText('ppt/presentation.xml');
  const slideSizeMatch = presentationXml.match(/<p:sldSz\b([^>]*)\/?\s*>/i);
  const slideSizeAttributes = parseAttributes(slideSizeMatch?.[1] || '');
  const slideSize = {
    width: Number(slideSizeAttributes.cx) || 12_192_000,
    height: Number(slideSizeAttributes.cy) || 6_858_000,
  };
  details.slideSize = slideSize;

  const slideEntries = archive.entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((left, right) => slideNumber(left.name) - slideNumber(right.name));
  details.slides = slideEntries.length;
  checks.push('Speaker notes, hidden slides, hidden objects, off-slide objects, cropped images, and alt text');

  let noteCount = 0;
  let hiddenSlideCount = 0;
  let hiddenObjectCount = 0;
  let offSlideCount = 0;
  let croppedImageCount = 0;
  const usedNotes = new Set();

  for (const slideEntry of slideEntries) {
    const number = slideNumber(slideEntry.name);
    const location = `Slide ${number}`;
    const xml = readText(slideEntry.name);
    if (!xml) continue;
    const rootAttributes = parseAttributes(xml.match(/<p:sld\b([^>]*)>/i)?.[1] || '');
    const hiddenSlide = falseyXml(rootAttributes.show);
    if (hiddenSlide) {
      hiddenSlideCount += 1;
      const text = compact(extractTextRuns(xml), 1600);
      findings.push(finding({
        ruleId: 'pptx.slide.hidden', severity: 'medium', title: 'Hidden slide remains in the presentation',
        summary: 'Hidden slides are still part of the file and can be opened or unhidden by the recipient.',
        evidence: text || 'Hidden slide with no extractable text', location,
        remediation: 'Delete the slide if it should not be delivered. Hiding it is not removal.', tags: ['hidden-slide', 'recoverable-content'],
      }));
      if (text) addSensitiveFindings(text, location, findings);
    }

    const relName = relationshipsPart(slideEntry.name);
    const relationships = parseRelationships(readText(relName, true));
    const relationshipMap = new Map(relationships.map((item) => [item.id, resolvePart(slideEntry.name, item.target)]));
    const notesRelationship = relationships.find((item) => /\/notesSlide$/i.test(item.type));
    if (notesRelationship) {
      const notesPart = resolvePart(slideEntry.name, notesRelationship.target);
      usedNotes.add(notesPart);
      const notesXml = readText(notesPart, true);
      const notesText = compact(extractTextRuns(notesXml), 2400);
      if (notesText) {
        noteCount += 1;
        findings.push(finding({
          ruleId: 'pptx.notes', severity: 'high', title: 'Speaker notes remain in the presentation',
          summary: 'Speaker notes are stored inside the file and can be read by the recipient.',
          evidence: notesText, location,
          remediation: 'Delete speaker notes in a copy intended for sharing, run Document Inspector, save, and scan the copy again.',
          tags: ['speaker-notes', 'hidden-content'],
        }));
        addSensitiveFindings(notesText, `${location} speaker notes`, findings);
      }
    }

    for (const block of shapeBlocks(xml)) {
      const shape = shapeDetails(block.xml);
      const objectLocation = `${location} — ${shape.name}`;
      if (shape.hidden) {
        hiddenObjectCount += 1;
        findings.push(finding({
          ruleId: 'pptx.object.hidden', severity: 'medium', title: 'Hidden slide object detected',
          summary: 'The object is marked hidden but remains stored in the presentation.',
          evidence: shape.text || shape.description || shape.title || shape.name, location: objectLocation,
          remediation: 'Delete objects that should not be delivered rather than marking them hidden.', tags: ['hidden-object', 'recoverable-content'],
        }));
        addSensitiveFindings([shape.text, shape.description, shape.title].filter(Boolean).join('\n'), objectLocation, findings);
      }
      if (entirelyOffSlide(shape.geometry, slideSize)) {
        offSlideCount += 1;
        findings.push(finding({
          ruleId: 'pptx.object.off-slide', severity: 'medium', confidence: 'high', title: 'Object is positioned entirely outside the slide',
          summary: 'Off-slide objects do not appear in the normal slide canvas but remain extractable from the file.',
          evidence: shape.text || shape.description || shape.title || shape.name, location: objectLocation,
          remediation: 'Move the object onto the slide if it is intentional or delete it from the sharing copy.', tags: ['off-slide', 'hidden-content'],
          data: { geometry: shape.geometry },
        }));
        addSensitiveFindings([shape.text, shape.description, shape.title].filter(Boolean).join('\n'), objectLocation, findings);
      }
      if (hasCrop(shape.crop) && block.type === 'pic') {
        croppedImageCount += 1;
        const media = shape.relationshipId ? relationshipMap.get(shape.relationshipId) : '';
        findings.push(finding({
          ruleId: 'pptx.image.cropped', severity: 'medium', confidence: 'high', title: 'Cropped image may retain the removed areas',
          summary: 'PowerPoint stores the source image in the package. A recipient may be able to extract areas hidden by cropping.',
          evidence: media || shape.name, location: objectLocation,
          remediation: 'Use Compress Pictures with “Delete cropped areas of pictures,” or replace the image with a permanently cropped copy, then rescan.',
          tags: ['image', 'recoverable-content'], data: { crop: shape.crop },
        }));
      }
      const alternateText = [shape.title, shape.description].filter(Boolean).join(' — ');
      if (alternateText) addSensitiveFindings(alternateText, `${objectLocation} alternate text`, findings);
    }
  }

  const orphanNotes = archive.entries.filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry.name) && !usedNotes.has(entry.name));
  for (const entry of orphanNotes.slice(0, 20)) {
    const text = compact(extractTextRuns(readText(entry.name, true)), 1800);
    if (!text) continue;
    noteCount += 1;
    findings.push(finding({
      ruleId: 'pptx.notes.orphaned', severity: 'high', title: 'Unlinked speaker-note content remains in the package',
      summary: 'A notes part exists even though no current slide relationship points to it.',
      evidence: text, location: entry.name,
      remediation: 'Rebuild the sharing copy or remove orphaned package parts using a trusted Office repair workflow.', tags: ['speaker-notes', 'orphaned-content'],
    }));
    addSensitiveFindings(text, entry.name, findings);
  }

  details.notes = noteCount;
  details.hiddenSlides = hiddenSlideCount;
  details.hiddenObjects = hiddenObjectCount;
  details.offSlideObjects = offSlideCount;
  details.croppedImages = croppedImageCount;

  checks.push('Comments and collaboration data');
  const commentAuthorXml = readText('ppt/commentAuthors.xml', true);
  const authorNames = new Map(tags(commentAuthorXml, 'cmAuthor').map(({ attributes }) => [attributes.id || '', attributes.name || attributes.initials || '']));
  const commentEntries = archive.entries.filter((entry) => /^ppt\/comments\/.*\.xml$/i.test(entry.name));
  let commentCount = 0;
  for (const entry of commentEntries.slice(0, 200)) {
    const xml = readText(entry.name, true);
    const text = commentText(xml);
    if (!text) continue;
    commentCount += 1;
    const authors = [...new Set([...xml.matchAll(/authorId\s*=\s*["']([^"']+)["']/gi)].map((match) => authorNames.get(match[1])).filter(Boolean))];
    findings.push(finding({
      ruleId: 'pptx.comments', severity: 'medium', title: 'Review comments remain in the presentation',
      summary: 'Comment text and collaboration context can be inspected by the recipient.',
      evidence: text, location: authors.length ? `${entry.name} — ${authors.join(', ')}` : entry.name,
      remediation: 'Resolve and delete comments in the sharing copy, run Document Inspector, and scan again.', tags: ['comments', 'collaboration'],
    }));
    addSensitiveFindings(text, entry.name, findings);
  }
  const modernCommentParts = archive.entries.filter((entry) => /(?:^|\/)(?:people|persons|authors|commentAuthors)\.xml$/i.test(entry.name) || /\/commentsExt\//i.test(entry.name));
  details.commentFiles = commentEntries.length;
  details.commentsWithText = commentCount;
  if (modernCommentParts.length && !commentEntries.length) {
    findings.push(finding({
      ruleId: 'pptx.collaboration', severity: 'low', title: 'Collaboration identity data detected',
      summary: 'The package includes people or author records associated with collaboration features.',
      evidence: modernCommentParts.slice(0, 10).map((entry) => entry.name).join(', '),
      remediation: 'Run Document Inspector and remove collaboration metadata that is not intended for recipients.', tags: ['collaboration', 'identity'],
    }));
  }

  checks.push('Embedded files, custom XML, and retained application data');
  const embedded = archive.entries.filter((entry) => entry.name.startsWith('ppt/embeddings/') && !entry.directory);
  if (embedded.length) {
    findings.push(finding({
      ruleId: 'pptx.embedded-files', severity: 'high', title: 'Embedded files remain in the presentation',
      summary: 'Recipients may be able to open or extract the original embedded documents and their underlying data.',
      evidence: embedded.slice(0, 15).map((entry) => `${entry.name} (${formatBytes(entry.uncompressedSize)})`).join(', '),
      remediation: 'Remove embedded objects or replace them with reviewed static images in the sharing copy.', tags: ['attachment', 'embedded-object'],
    }));
  }
  details.embeddedFiles = embedded.length;

  const customXmlEntries = archive.entries.filter((entry) => /^customXml\/(?!_rels\/).*\.xml$/i.test(entry.name));
  if (customXmlEntries.length) {
    const excerpts = [];
    for (const entry of customXmlEntries.slice(0, 20)) {
      const text = compact(stripXml(readText(entry.name, true)), 600);
      if (text) {
        excerpts.push(`${entry.name}: ${text}`);
        addSensitiveFindings(text, entry.name, findings);
      }
    }
    findings.push(finding({
      ruleId: 'pptx.custom-xml', severity: 'medium', title: 'Custom XML data detected',
      summary: 'The presentation package contains application-defined XML that is not normally visible on slides.',
      evidence: excerpts.length ? excerpts.slice(0, 8).join(' | ') : customXmlEntries.slice(0, 10).map((entry) => entry.name).join(', '),
      remediation: 'Confirm custom XML is required. Remove it from a sharing copy when it contains internal application or workflow data.',
      tags: ['custom-xml', 'hidden-content'],
    }));
  }
  details.customXmlParts = customXmlEntries.length;

  const revisionParts = archive.entries.filter((entry) => /(?:revision|userData|viewProps|presProps|tags)\//i.test(entry.name));
  if (revisionParts.length) {
    findings.push(finding({
      ruleId: 'pptx.retained-state', severity: 'low', title: 'Retained editing or presentation-state parts detected',
      summary: 'The package contains internal state such as tags, views, or revision-related parts that are not central to slide rendering.',
      evidence: revisionParts.slice(0, 12).map((entry) => entry.name).join(', '),
      remediation: 'Use Document Inspector and save a clean distribution copy if these parts are not required.', tags: ['editing-state'],
    }));
  }

  checks.push('External relationships and linked data');
  const external = [];
  for (const entry of archive.entries.filter((item) => item.name.endsWith('.rels'))) {
    const xml = readText(entry.name, true);
    for (const relationship of parseRelationships(xml)) {
      if (relationship.external) external.push({ source: entry.name, ...relationship });
    }
  }
  const localLinks = external.filter((item) => /^(?:file:|[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/)/i.test(item.target));
  const linkedData = external.filter((item) => !/\/hyperlink$/i.test(item.type) && !localLinks.includes(item));
  const hyperlinks = external.filter((item) => /\/hyperlink$/i.test(item.type) && !localLinks.includes(item));
  if (localLinks.length) {
    findings.push(finding({
      ruleId: 'pptx.external.local-path', severity: 'medium', title: 'Local or network file paths remain in the presentation',
      summary: 'Linked paths can reveal usernames, directory structures, server names, or internal locations.',
      evidence: localLinks.slice(0, 12).map((item) => safeTarget(item.target)).join(', '),
      remediation: 'Break external file links or replace linked content with reviewed embedded/static content before sharing.', tags: ['external-link', 'local-path'],
    }));
  }
  if (linkedData.length) {
    findings.push(finding({
      ruleId: 'pptx.external.linked-data', severity: 'medium', title: 'External linked content detected',
      summary: 'The presentation references external data, media, or objects that may reveal locations or change after delivery.',
      evidence: linkedData.slice(0, 12).map((item) => `${item.type.split('/').pop()}: ${safeTarget(item.target)}`).join(', '),
      remediation: 'Break or review external links and create a self-contained distribution copy.', tags: ['external-link', 'linked-data'],
    }));
  }
  if (hyperlinks.length) {
    findings.push(finding({
      ruleId: 'pptx.external.hyperlinks', severity: 'low', title: 'External hyperlinks detected',
      summary: 'Hyperlinks may be intentional, but their targets and query parameters are stored in the file package.',
      evidence: hyperlinks.slice(0, 12).map((item) => safeTarget(item.target)).join(', '),
      remediation: 'Review every hyperlink and remove tracking, private, expired, or recipient-specific URLs.', tags: ['hyperlink'],
    }));
    for (const item of hyperlinks) addSensitiveFindings(item.target, `${item.source} external relationship`, findings);
  }
  details.externalRelationships = external.length;

  checks.push('Embedded image metadata');
  const imageMetadata = [];
  for (const entry of archive.entries.filter((item) => item.name.startsWith('ppt/media/') && !item.directory)) {
    if (entry.uncompressedSize > MAX_MEDIA_SCAN_BYTES) {
      limitations.push(`${entry.name} exceeds the embedded-image metadata inspection limit.`);
      continue;
    }
    try {
      const result = inspectImageMetadata(entry.read());
      if (!result) continue;
      if (result.coordinates || Object.keys(result.fields).length) imageMetadata.push({ name: entry.name, ...result });
    } catch (error) {
      if (error instanceof ZipError) limitations.push(`${entry.name} could not be inspected: ${error.message}`);
    }
  }
  const geotagged = imageMetadata.filter((item) => item.coordinates);
  if (geotagged.length) {
    findings.push(finding({
      ruleId: 'pptx.image.gps', severity: 'high', title: 'GPS coordinates remain in an embedded image',
      summary: 'The original image metadata contains a location that a recipient may be able to extract from the presentation package.',
      evidence: geotagged.slice(0, 8).map((item) => `${item.name}: ${item.coordinates.latitude.toFixed(5)}, ${item.coordinates.longitude.toFixed(5)}`).join('; '),
      remediation: 'Strip image metadata or replace the image with a metadata-free copy, then save and rescan the presentation.', tags: ['image', 'gps', 'metadata'],
    }));
  }
  const identifyingImageMetadata = imageMetadata.filter((item) => Object.keys(item.fields).length);
  if (identifyingImageMetadata.length) {
    findings.push(finding({
      ruleId: 'pptx.image.metadata', severity: 'medium', title: 'Identifying metadata remains in embedded images',
      summary: 'Camera, owner, software, copyright, or creation information may be extractable from original images.',
      evidence: identifyingImageMetadata.slice(0, 8).map((item) => `${item.name}: ${Object.entries(item.fields).slice(0, 5).map(([key, value]) => `${key}=${compact(String(value), 80)}`).join(', ')}`).join('; '),
      remediation: 'Strip metadata from source images or replace them with clean copies before sharing.', tags: ['image', 'metadata'],
    }));
  }
  details.imagesWithMetadata = imageMetadata.length;

  const complete = limitations.length === 0 && encryptedEntries.length === 0;
  return { findings, coverage: { complete, checks, limitations, details } };
}
