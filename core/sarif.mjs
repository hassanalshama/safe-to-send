// @ts-check

/** @param {any[]} reports */
export function renderSarif(reports) {
  const rules = new Map();
  const results = [];
  for (const report of reports) {
    for (const item of report.findings) {
      if (!rules.has(item.ruleId)) {
        rules.set(item.ruleId, {
          id: item.ruleId,
          name: item.ruleId.replaceAll(/[^A-Za-z0-9]+/g, '_'),
          shortDescription: { text: item.title },
          fullDescription: { text: item.summary },
          help: { text: item.remediation || item.summary },
          defaultConfiguration: {
            level: item.severity === 'high' ? 'error' : item.severity === 'medium' ? 'warning' : 'note',
          },
          properties: { tags: item.tags || [], confidence: item.confidence },
        });
      }
      results.push({
        ruleId: item.ruleId,
        level: item.severity === 'high' ? 'error' : item.severity === 'medium' ? 'warning' : 'note',
        message: { text: [item.title, item.summary, item.evidence ? `Evidence: ${item.evidence}` : '', item.location ? `Location: ${item.location}` : ''].filter(Boolean).join(' — ') },
        locations: [{ physicalLocation: { artifactLocation: { uri: report.file.name } } }],
        properties: { severity: item.severity, confidence: item.confidence, findingId: item.id },
      });
    }
    if (!report.coverage.complete) {
      const ruleId = 'safe-to-send.scan-incomplete';
      if (!rules.has(ruleId)) rules.set(ruleId, {
        id: ruleId,
        name: 'scan_incomplete',
        shortDescription: { text: 'Safe to Send scan incomplete' },
        fullDescription: { text: 'One or more parts of the file could not be inspected.' },
        defaultConfiguration: { level: 'warning' },
      });
      results.push({
        ruleId,
        level: 'warning',
        message: { text: report.coverage.limitations.join(' ') || 'The scan did not cover the complete file.' },
        locations: [{ physicalLocation: { artifactLocation: { uri: report.file.name } } }],
      });
    }
  }
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'Safe to Send', version: reports[0]?.scanner?.version || 'unknown', informationUri: 'https://github.com/hassanalshama/safe-to-send', rules: [...rules.values()] } },
      results,
    }],
  };
}
