const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const escapePdfText = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)')
  .replace(/\r?\n/g, ' ');

const page = { width: 612, height: 792, margin: 36 };
const rowHeight = 24;
const theme = { r: 140 / 255, g: 198 / 255, b: 63 / 255 };
const logoSize = { width: 138, height: 42 };
const borderWidth = 0.35;
const cellPaddingX = 5;
const cellPaddingY = 6;
const lineGap = 10;

const text = (value, x, y, size = 9, font = 'F1') => `BT\n/${font} ${size} Tf\n1 0 0 1 ${x} ${y} Tm\n(${escapePdfText(value)}) Tj\nET`;
const line = (x1, y1, x2, y2) => `${x1} ${y1} m\n${x2} ${y2} l\nS`;
const rect = (x, y, width, height) => `${borderWidth} w\n${x} ${y} ${width} ${height} re\nS\n1 w`;
const fillRect = (x, y, width, height, gray = 0.94) => `${gray} g\n${x} ${y} ${width} ${height} re\nf\n0 g`;
const rgb = (r, g, b) => `${r} ${g} ${b} rg\n${r} ${g} ${b} RG`;
const strokeRgb = (r, g, b) => `${r} ${g} ${b} RG`;
const resetColor = () => '0 g\n0 G';

const appGradientBackground = () => {
  const bands = [];
  const count = 36;
  const width = Math.ceil(page.width / count) + 1;
  for (let i = 0; i < count; i += 1) {
    const ratio = i / (count - 1);
    const r = (248 - ((248 - 232) * ratio)) / 255;
    const g = (252 - ((252 - 248) * ratio)) / 255;
    const b = (244 - ((244 - 247) * ratio)) / 255;
    bands.push(rgb(r, g, b));
    bands.push(`${i * width} 0 ${width} ${page.height} re\nf`);
  }
  bands.push(resetColor());
  return bands.join('\n');
};

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

const readPng = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const input = fs.readFileSync(filePath);
  if (input.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.slice(offset + 4, offset + 8).toString('ascii');
    const data = input.slice(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || colorType !== 6) return null;

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * bytesPerPixel);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source];
    source += 1;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[source + x];
      const left = x >= bytesPerPixel ? rgba[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? rgba[rowStart + x - stride] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? rgba[rowStart + x - stride - bytesPerPixel] : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      rgba[rowStart + x] = value & 255;
    }
    source += stride;
  }

  const rgbData = Buffer.alloc(width * height * 3);
  const alphaData = Buffer.alloc(width * height);
  for (let i = 0, j = 0, a = 0; i < rgba.length; i += 4, j += 3, a += 1) {
    rgbData[j] = rgba[i];
    rgbData[j + 1] = rgba[i + 1];
    rgbData[j + 2] = rgba[i + 2];
    alphaData[a] = rgba[i + 3];
  }
  return { width, height, rgbData, alphaData };
};

const getLogo = () => readPng(path.resolve(__dirname, '../../../../ayedos-webapp/src/assets/logo-light.png'));

const logoLockup = (x, y, logoName) => [
  logoName ? `q\n${logoSize.width} 0 0 ${logoSize.height} ${x} ${y - 32} cm\n/${logoName} Do\nQ` : text('AYEDOS SACCO', x, y - 4, 16, 'F2'),
].join('\n');

const wrapText = (value, limit, maxLines = 4) => {
  const output = String(value ?? '-').replace(/\s+/g, ' ').trim() || '-';
  if (output.length <= limit) return [output];
  const lines = [];
  let current = '';
  output.split(' ').forEach((word) => {
    if (word.length > limit) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += limit) lines.push(word.slice(i, i + limit));
      return;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > limit) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
};

const textLines = (lines, x, y, size = 8, font = 'F1', gap = 10) => lines
  .map((lineText, index) => text(lineText, x, y - (index * gap), size, font))
  .join('\n');

const rowLines = (row, columns, widths, maxLines = 4) => columns.map((column, index) => {
  const limit = Math.max(10, Math.floor((widths[index] - (cellPaddingX * 2)) / 3.8));
  return wrapText(row[column], limit, maxLines);
});

const dynamicRowHeight = (linesByColumn) => Math.max(rowHeight, (cellPaddingY * 2) + (Math.max(...linesByColumn.map((lines) => lines.length), 1) * lineGap));

const headerLines = (columns, widths) => columns.map((column, index) => {
  const limit = Math.max(10, Math.floor((widths[index] - (cellPaddingX * 2)) / 3.8));
  return wrapText(column, limit, 3);
});

const columnWidths = (columns) => {
  const usable = page.width - (page.margin * 2);
  const base = Math.floor(usable / columns.length);
  const widths = columns.map(() => base);
  widths[widths.length - 1] += usable - widths.reduce((sum, width) => sum + width, 0);
  return widths;
};

const paginate = ({ memberNumber, reportName, durationLabel, summaryRows, sections }, assets = {}) => {
  const pages = [];
  let commands = [];
  let y = page.height - page.margin;

  const addPage = () => {
    if (commands.length) pages.push(commands);
    commands = [appGradientBackground()];
    y = page.height - page.margin;
  };

  const ensureSpace = (height) => {
    if (y - height < page.margin + 28) addPage();
  };

  addPage();
  commands.push(logoLockup((page.width - logoSize.width) / 2, y, assets.logoName));
  y -= 58;
  commands.push(text(`${memberNumber || 'Member'} - ${reportName}`, page.margin, y, 15, 'F2'));
  y -= 18;
  commands.push(text(`Request date: ${new Date().toLocaleString()}`, page.margin, y, 9));
  commands.push(text(`Period: ${durationLabel || 'All records'}`, page.margin + 210, y, 9));
  y -= 22;
  if (summaryRows?.length) {
    commands.push(text('Summary', page.margin, y, 11, 'F2'));
    y -= 18;
    summaryRows.forEach(([label, value]) => {
      ensureSpace(16);
      commands.push(text(label, page.margin, y, 9, 'F2'));
      commands.push(text(value, page.width - page.margin - 170, y, 9));
      y -= 15;
    });
    y -= 10;
  }

  sections.forEach((section) => {
    const columns = section.columns || section.headers || [];
    const widths = columnWidths(columns);
    const headerWrapped = headerLines(columns, widths);
    const headerHeight = dynamicRowHeight(headerWrapped);
    ensureSpace(48 + headerHeight);
    commands.push(rgb(0.0, 0.23, 0.09));
    commands.push(text(section.title, page.margin, y - 8, 11, 'F2'));
    commands.push(resetColor());
    y -= 40;
    commands.push(rgb(theme.r, theme.g, theme.b));
    commands.push(`${page.margin} ${y - 6} ${page.width - (page.margin * 2)} ${headerHeight} re\nf`);
    commands.push(strokeRgb(theme.r, theme.g, theme.b));
    let x = page.margin;
    columns.forEach((column, index) => {
      commands.push(rect(x, y - 6, widths[index], headerHeight));
      commands.push(rgb(1, 1, 1));
      commands.push(textLines(headerWrapped[index], x + cellPaddingX, y + headerHeight - cellPaddingY - 8, 8, 'F2', lineGap));
      commands.push(resetColor());
      commands.push(strokeRgb(theme.r, theme.g, theme.b));
      x += widths[index];
    });
    commands.push(resetColor());
    y -= headerHeight;

    const rows = section.rows?.length ? section.rows : [Object.fromEntries(columns.map((column, index) => [column, index === 0 ? 'No records found.' : '']))];
    rows.forEach((row) => {
      const wrapped = rowLines(row, columns, widths);
      const height = dynamicRowHeight(wrapped);
      ensureSpace(height + 4);
      x = page.margin;
      commands.push(strokeRgb(theme.r, theme.g, theme.b));
      columns.forEach((column, index) => {
        commands.push(rect(x, y - 6, widths[index], height));
        commands.push(textLines(wrapped[index], x + cellPaddingX, y + height - cellPaddingY - 8, 8, 'F1', lineGap));
        x += widths[index];
      });
      commands.push(resetColor());
      y -= height;
    });
    y -= 16;
  });

  pages.push(commands);
  pages.forEach((pageCommands, index) => {
    pageCommands.push(strokeRgb(theme.r, theme.g, theme.b));
    pageCommands.push(line(page.margin, 30, page.width - page.margin, 30));
    pageCommands.push(resetColor());
    pageCommands.push(text('AYEDOS SACCO', page.margin, 16, 8, 'F2'));
    pageCommands.push(text(`Page ${index + 1} of ${pages.length}`, page.width - page.margin - 60, 16, 8));
  });
  return pages;
};

const buildPdf = (pageCommands) => {
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };

  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const logo = getLogo();
  let logoImageId = null;
  if (logo) {
    const compressedAlpha = zlib.deflateSync(logo.alphaData).toString('hex');
    const compressedRgb = zlib.deflateSync(logo.rgbData);
    const compressedRgbHex = compressedRgb.toString('hex');
    const alphaId = addObject(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${compressedAlpha.length + 1} >>\nstream\n${compressedAlpha}>\nendstream`);
    logoImageId = addObject(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /SMask ${alphaId} 0 R /Length ${compressedRgbHex.length + 1} >>\nstream\n${compressedRgbHex}>\nendstream`);
  }
  const pageIds = pageCommands.map((commands) => {
    const stream = commands.join('\n');
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const xObjects = logoImageId ? `/XObject << /Logo ${logoImageId} 0 R >>` : '';
    return addObject(`<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> ${xObjects} >> /Contents ${contentId} 0 R >>`);
  });

  const pagesId = addObject(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  pageIds.forEach((pageId) => {
    objects[pageId - 1] = objects[pageId - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  });
  const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
};

const buildBrandedReportPdf = (report) => {
  const logo = getLogo();
  return buildPdf(paginate(report, { logoName: logo ? 'Logo' : null }));
};

module.exports = {
  buildBrandedReportPdf,
};
