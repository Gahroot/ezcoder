# frozen_string_literal: true

require "rails_helper"
require "zip"
require "stringio"

# Proves {EZAgentRails::DocumentText} decodes uploaded documents to plain text
# so their contents can be inlined into the LLM prompt, and degrades safely
# (returns nil, never raises) for unsupported or corrupt input.
RSpec.describe EZAgentRails::DocumentText do
  XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  PPTX_CT = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

  # A minimal, valid one-page PDF whose single text run reads "Hello PDF World".
  def build_pdf(text)
    stream = "BT /F1 24 Tf 72 700 Td (#{text}) Tj ET"
    objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " \
        "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      "<< /Length #{stream.bytesize} >>\nstream\n#{stream}\nendstream",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ]

    pdf = +"%PDF-1.4\n"
    offsets = []
    objs.each_with_index do |o, i|
      offsets << pdf.bytesize
      pdf << "#{i + 1} 0 obj\n#{o}\nendobj\n"
    end
    xref_pos = pdf.bytesize
    pdf << "xref\n0 #{objs.size + 1}\n0000000000 65535 f \n"
    offsets.each { |off| pdf << format("%010d 00000 n \n", off) }
    pdf << "trailer\n<< /Size #{objs.size + 1} /Root 1 0 R >>\n" \
           "startxref\n#{xref_pos}\n%%EOF"
    pdf
  end

  # A minimal DOCX (OOXML) with two paragraphs of text.
  def build_docx(paragraphs)
    runs = paragraphs.map { |p| "<w:p><w:r><w:t>#{p}</w:t></w:r></w:p>" }.join
    xml = <<~XML
      <?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>#{runs}</w:body></w:document>
    XML
    zip_buffer("word/document.xml" => xml)
  end

  # Write a Hash of { entry_path => content } into an in-memory ZIP and return
  # its bytes — the OOXML container shape used by DOCX/XLSX/PPTX.
  def zip_buffer(entries)
    buf = Zip::OutputStream.write_buffer do |z|
      entries.each do |name, content|
        z.put_next_entry(name)
        z.write(content)
      end
    end
    buf.rewind
    buf.read
  end

  # A minimal XLSX with one sheet + shared strings. A1/B1 are shared-string
  # headers, A2 is a shared string, B2 is a bare number.
  def build_xlsx
    shared = <<~XML
      <?xml version="1.0"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
        <si><t>Investor</t></si><si><t>Amount</t></si><si><t>Acme LP</t></si>
      </sst>
    XML
    sheet = <<~XML
      <?xml version="1.0"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>50000</v></c></row>
      </sheetData></worksheet>
    XML
    workbook = <<~XML
      <?xml version="1.0"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="Investors" sheetId="1" r:id="rId1"/></sheets>
      </workbook>
    XML
    rels = <<~XML
      <?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
      </Relationships>
    XML
    zip_buffer(
      "xl/sharedStrings.xml" => shared,
      "xl/worksheets/sheet1.xml" => sheet,
      "xl/workbook.xml" => workbook,
      "xl/_rels/workbook.xml.rels" => rels
    )
  end

  # A minimal PPTX with one slide carrying two text runs.
  def build_pptx
    slide = <<~XML
      <?xml version="1.0"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>
          <a:t>Q3 Fund Performance</a:t>
          <a:t>Net asset value up 8 percent</a:t>
        </p:spTree></p:cSld>
      </p:sld>
    XML
    zip_buffer("ppt/slides/slide1.xml" => slide)
  end

  describe ".extract" do
    it "extracts text from a PDF by content type" do
      att = { "name" => "proposal.bin", "content_type" => "application/pdf" }
      text = described_class.extract(build_pdf("Hello PDF World"), att)
      expect(text).to include("Hello PDF World")
    end

    it "extracts text from a PDF by .pdf extension" do
      att = { "name" => "proposal.pdf", "content_type" => "application/octet-stream" }
      text = described_class.extract(build_pdf("Quarterly returns up 12 percent"), att)
      expect(text).to include("Quarterly returns up 12 percent")
    end

    it "extracts paragraph text from a DOCX, one line per paragraph" do
      att = { "name" => "memo.docx", "content_type" => "" }
      text = described_class.extract(build_docx(["First line", "Second line"]), att)
      expect(text).to eq("First line\nSecond line")
    end

    it "extracts tab-separated cell text from an XLSX, resolving shared strings" do
      att = { "name" => "investors.xlsx", "content_type" => XLSX_CT }
      text = described_class.extract(build_xlsx, att)
      expect(text).to include("Sheet: Investors")
      expect(text).to include("Investor\tAmount")
      expect(text).to include("Acme LP\t50000")
    end

    it "extracts an XLSX by .xlsx extension when content type is generic" do
      att = { "name" => "investors.xlsx", "content_type" => "application/octet-stream" }
      expect(described_class.extract(build_xlsx, att)).to include("Acme LP")
    end

    it "extracts slide text from a PPTX in slide order" do
      att = { "name" => "deck.pptx", "content_type" => PPTX_CT }
      text = described_class.extract(build_pptx, att)
      expect(text).to include("Slide 1:")
      expect(text).to include("Q3 Fund Performance")
      expect(text).to include("Net asset value up 8 percent")
    end

    it "returns nil for an unsupported attachment type" do
      att = { "name" => "data.bin", "content_type" => "application/octet-stream" }
      expect(described_class.extract("\x00\x01\x02", att)).to be_nil
    end

    it "returns nil (never raises) for corrupt PDF bytes" do
      att = { "name" => "broken.pdf", "content_type" => "application/pdf" }
      expect(described_class.extract("not really a pdf", att)).to be_nil
    end

    it "returns nil (never raises) for corrupt XLSX bytes" do
      att = { "name" => "broken.xlsx", "content_type" => XLSX_CT }
      expect(described_class.extract("PK\x03\x04 not a real zip", att)).to be_nil
    end
  end

  # A ZIP entry can declare a tiny (or absent) uncompressed size in its header
  # while inflating to gigabytes — a decompression bomb. The byte ceiling must be
  # enforced DURING inflation, not by trusting the attacker-controlled header.
  describe ".read_bounded (zip-bomb guard)" do
    # A fake ZIP entry whose stream inflates far past its (forged-small) header.
    def lying_entry(real_bytes)
      entry = Object.new
      entry.define_singleton_method(:name) { "evil.bin" }
      entry.define_singleton_method(:get_input_stream) { StringIO.new("A" * real_bytes) }
      entry
    end

    it "aborts inflation the moment an entry exceeds its byte ceiling" do
      entry = lying_entry(8 * 1024 * 1024)
      expect { described_class.send(:read_bounded, entry, 1 * 1024 * 1024) }
        .to raise_error(EZAgentRails::DocumentText::ZipBombError)
    end

    it "returns the content of an entry within its ceiling" do
      entry = lying_entry(16)
      expect(described_class.send(:read_bounded, entry, 1024)).to eq("A" * 16)
    end

    it "degrades safely (returns nil, never raises) when extraction hits a bomb" do
      stub_const("#{described_class}::MAX_ENTRY_BYTES", 1024)
      att = { "name" => "bomb.docx", "content_type" => described_class::DOCX_CONTENT_TYPE }
      bytes = zip_buffer("word/document.xml" => "<w:t>x</w:t>", "big.bin" => "A" * (2 * 1024 * 1024))
      expect { described_class.extract(bytes, att) }.not_to raise_error
    end
  end

  describe ".extractable?" do
    it "is true for PDF, DOCX, XLSX, and PPTX, false otherwise" do
      expect(described_class.extractable?("name" => "a.pdf", "content_type" => "")).to be(true)
      expect(described_class.extractable?("name" => "a.docx", "content_type" => "")).to be(true)
      expect(described_class.extractable?("name" => "a.xlsx", "content_type" => "")).to be(true)
      expect(described_class.extractable?("name" => "a.pptx", "content_type" => "")).to be(true)
      expect(described_class.extractable?("name" => "a.png", "content_type" => "image/png")).to be(false)
    end
  end
end
