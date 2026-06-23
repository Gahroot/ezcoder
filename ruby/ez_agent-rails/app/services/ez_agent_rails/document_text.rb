# frozen_string_literal: true

require "stringio"

module EZAgentRails
  # Extracts plain text from uploaded document attachments (PDF, DOCX, XLSX,
  # PPTX) so their contents can be inlined into the LLM prompt as a text block.
  #
  # The models consumed by this engine cannot read raw document bytes: a PDF,
  # Word, Excel, or PowerPoint file handed over verbatim is opaque binary. To let
  # the assistant genuinely answer questions about an uploaded document we decode
  # it to text here and inline that text ({RunJob#build_user_content}).
  #
  # The OOXML formats (DOCX/XLSX/PPTX) are ZIP containers of XML parts, so they
  # are decoded with rubyzip + nokogiri — the same primitives DOCX already used,
  # adding no new dependency. PDF uses pdf-reader.
  #
  # Extraction libraries are optional dependencies, required lazily so a host
  # that hasn't installed them (or the engine's own minimal test bundle) still
  # loads — {.extract} simply returns nil and the caller falls back to a
  # filename placeholder. Any extraction failure (corrupt/encrypted file,
  # missing gem) is rescued and logged, never raised, so a bad upload can never
  # abort a run.
  module DocumentText
    module_function

    PDF_CONTENT_TYPE  = "application/pdf"
    DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    PPTX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

    # Cap the extracted text so a huge workbook/deck can't blow the context
    # window; the inlined block is truncated with a marker past this length.
    MAX_TEXT_CHARS = 100_000

    # ZIP-bomb guards for the OOXML container: bound entry count, per-entry
    # uncompressed size, and total uncompressed bytes read.
    MAX_ZIP_ENTRIES = 2_000
    MAX_ENTRY_BYTES = 25 * 1024 * 1024
    MAX_TOTAL_BYTES = 60 * 1024 * 1024

    # Chunk size for the bounded streaming inflate (see {.read_bounded}).
    INFLATE_CHUNK_BYTES = 256 * 1024

    # Raised when an entry inflates past its byte ceiling — a zip bomb that
    # under-declares its uncompressed size. Rescued by {.extract} (fails safe).
    class ZipBombError < StandardError; end

    # Spreadsheet shape guards (mirroring discourse-ai's XlsxToText).
    MAX_SHEETS          = 50
    MAX_ROWS_PER_SHEET  = 10_000
    MAX_COLUMNS         = 200

    SHARED_STRINGS_PATH = "xl/sharedStrings.xml"
    WORKBOOK_PATH       = "xl/workbook.xml"
    WORKBOOK_RELS_PATH  = "xl/_rels/workbook.xml.rels"
    WORKSHEET_PATTERN   = %r{\Axl/worksheets/sheet\d+\.xml\z}
    SLIDE_PATTERN       = %r{\Appt/slides/slide\d+\.xml\z}

    # @param att [Hash] attachment metadata (`content_type`, `name`)
    # @return [Symbol, nil] :pdf, :docx, :xlsx, :pptx, or nil when unsupported
    def kind(att)
      ct  = att["content_type"].to_s.downcase
      ext = File.extname(att["name"].to_s).downcase

      return :pdf  if ct == PDF_CONTENT_TYPE  || ext == ".pdf"
      return :docx if ct == DOCX_CONTENT_TYPE || ext == ".docx"
      return :xlsx if ct == XLSX_CONTENT_TYPE || ext == ".xlsx"
      return :pptx if ct == PPTX_CONTENT_TYPE || ext == ".pptx"

      nil
    end

    # True when the attachment is a document this module knows how to decode.
    #
    # @param att [Hash]
    # @return [Boolean]
    def extractable?(att)
      !kind(att).nil?
    end

    # Extract plain text from a document's raw bytes.
    #
    # @param bytes [String] binary document content
    # @param att [Hash] attachment metadata
    # @return [String, nil] extracted text, or nil when unsupported/empty/failed
    def extract(bytes, att)
      text =
        case kind(att)
        when :pdf  then extract_pdf(bytes)
        when :docx then extract_docx(bytes)
        when :xlsx then extract_xlsx(bytes)
        when :pptx then extract_pptx(bytes)
        end

      return nil if text.blank?

      truncate(text.strip)
    rescue StandardError, LoadError => e
      Rails.logger.warn(
        "[EZAgentRails::DocumentText] extraction failed for " \
        "#{att['name'].inspect} (#{e.class}: #{e.message})"
      )
      nil
    end

    # @param bytes [String]
    # @return [String]
    def extract_pdf(bytes)
      require "pdf/reader"

      reader = PDF::Reader.new(StringIO.new(bytes))
      reader.pages.map(&:text).join("\n\n")
    end

    # Extract the visible text from a DOCX (Office Open XML) document by reading
    # the main `word/document.xml` part and concatenating its `<w:t>` runs,
    # one line per paragraph (`<w:p>`).
    #
    # @param bytes [String]
    # @return [String]
    def extract_docx(bytes)
      xml = zip_entries(bytes)[ "word/document.xml" ]
      return "" if xml.nil?

      doc = parse_xml(xml)
      doc.xpath("//body//p")
         .map { |p| p.xpath(".//t").map(&:text).join }
         .reject(&:empty?)
         .join("\n")
    end

    # Extract a spreadsheet (XLSX) to tab-separated text, one section per sheet,
    # resolving shared strings, inline strings, booleans, and formulas. Ported
    # from discourse-ai's XlsxToText, adapted to decode from in-memory bytes via
    # rubyzip rather than a file path.
    #
    # @param bytes [String]
    # @return [String]
    def extract_xlsx(bytes)
      entries = zip_entries(bytes)
      shared  = parse_shared_strings(entries[SHARED_STRINGS_PATH])
      sections = []
      chars = 0

      worksheet_sheets(entries).first(MAX_SHEETS).each do |sheet|
        body = sheet_text(entries[sheet[:path]], shared)
        next if body.blank?

        sections << "Sheet: #{sheet[:name]}\n#{body}"
        chars += sections.last.length
        break if chars > MAX_TEXT_CHARS
      end

      sections.join("\n\n")
    end

    # Extract a presentation (PPTX) to text, one section per slide, in slide
    # order, concatenating each slide's `<a:t>` runs.
    #
    # @param bytes [String]
    # @return [String]
    def extract_pptx(bytes)
      entries = zip_entries(bytes)
      slides = entries.keys.grep(SLIDE_PATTERN).sort_by { |name| name[/\d+/].to_i }

      slides.filter_map.with_index do |name, index|
        doc = parse_xml(entries[name])
        text = doc.xpath("//t").map(&:text).reject(&:empty?).join("\n")
        next if text.empty?

        "Slide #{index + 1}:\n#{text}"
      end.join("\n\n")
    end

    # ── ZIP / XML helpers ──────────────────────────────────────────────

    # Read every (non-directory) entry of an OOXML ZIP container into a
    # name => content Hash in a single pass, bounded against ZIP bombs.
    #
    # @param bytes [String]
    # @return [Hash{String => String}]
    def zip_entries(bytes)
      require "zip"

      entries = {}
      count = 0
      total = 0
      # `open_buffer` with a block returns the closed buffer (not the block's
      # value) on rubyzip 3.x, so capture into a local.
      Zip::File.open_buffer(StringIO.new(bytes)) do |zip|
        zip.each do |entry|
          next if entry.directory?

          count += 1
          break if count > MAX_ZIP_ENTRIES
          next if entry.size && entry.size > MAX_ENTRY_BYTES

          # Enforce the ceiling DURING inflation: the declared `entry.size` above
          # is attacker-controlled, and rubyzip's `get_input_stream.read` is
          # otherwise unbounded, so a bomb declaring a tiny size would inflate to
          # gigabytes in memory before any post-hoc total check.
          content = read_bounded(entry, [MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - total].min)
          total += content.bytesize
          entries[entry.name] = content
        end
      end
      entries
    end

    # Inflate one ZIP entry in fixed-size chunks, aborting the moment it exceeds
    # `limit` bytes. This makes the {MAX_ENTRY_BYTES}/{MAX_TOTAL_BYTES} guards
    # real against a zip bomb that under-declares its uncompressed size, instead
    # of trusting the header and reading the whole stream into memory at once.
    #
    # @param entry [Zip::Entry]
    # @param limit [Integer] hard byte ceiling for this entry's inflated content
    # @return [String]
    def read_bounded(entry, limit)
      io = entry.get_input_stream
      buffer = +"".b
      while (chunk = io.read(INFLATE_CHUNK_BYTES))
        buffer << chunk
        raise ZipBombError, "entry #{entry.name.inspect} exceeded #{limit} bytes" if buffer.bytesize > limit
      end
      buffer
    ensure
      io&.close
    end

    # @param xml [String, nil]
    # @return [Nokogiri::XML::Document] namespaces stripped for simple xpath
    def parse_xml(xml)
      require "nokogiri"

      doc = Nokogiri::XML(force_utf8(xml)) { |config| config.recover.nonet }
      doc.remove_namespaces!
      doc
    end

    # Parse `xl/sharedStrings.xml` into an ordered Array the worksheets index by
    # position (cell type "s" carries the shared-string index).
    #
    # @param xml [String, nil]
    # @return [Array<String>]
    def parse_shared_strings(xml)
      return [] if xml.nil?

      parse_xml(xml).xpath("//sst/si").map { |si| normalize(string_item_text(si)) }
    end

    # Resolve the ordered list of sheets from the workbook + its relationships,
    # falling back to enumerating xl/worksheets/sheetN.xml when either is absent.
    #
    # @param entries [Hash{String => String}]
    # @return [Array<Hash>] each { name:, path: }
    def worksheet_sheets(entries)
      workbook = entries[WORKBOOK_PATH]
      return fallback_sheets(entries) if workbook.nil?

      rels = workbook_relationships(entries[WORKBOOK_RELS_PATH])
      sheets = parse_xml(workbook).xpath("//sheets/sheet").filter_map do |sheet|
        path = rels[sheet["id"]]
        next if path.nil?

        { name: sheet["name"].presence || File.basename(path, ".xml"), path: path }
      end
      sheets.presence || fallback_sheets(entries)
    end

    # @param xml [String, nil]
    # @return [Hash{String => String}] relationship id => worksheet entry path
    def workbook_relationships(xml)
      return {} if xml.nil?

      parse_xml(xml).xpath("//Relationship").each_with_object({}) do |rel, memo|
        id = rel["Id"]
        target = rel["Target"]
        memo[id] = normalize_target(target) if id.present? && target.present?
      end
    end

    # @param entries [Hash{String => String}]
    # @return [Array<Hash>]
    def fallback_sheets(entries)
      entries.keys.grep(WORKSHEET_PATTERN)
             .sort_by { |name| name[/\d+/].to_i }
             .map.with_index { |name, index| { name: "Sheet#{index + 1}", path: name } }
    end

    # Resolve a workbook-relative relationship target (e.g. "worksheets/sheet1.xml"
    # or "/xl/worksheets/sheet1.xml") to its entry path inside the container.
    #
    # @param target [String]
    # @return [String]
    def normalize_target(target)
      path = target.delete_prefix("/")
      path = File.join("xl", path) unless path.start_with?("xl/")
      path
    end

    # ── Worksheet cell decoding ────────────────────────────────────────

    # @param xml [String, nil]
    # @param shared [Array<String>]
    # @return [String] tab-separated rows, newline-separated
    def sheet_text(xml, shared)
      return "" if xml.nil?

      rows = parse_xml(xml).xpath("//sheetData/row")
      rows.first(MAX_ROWS_PER_SHEET)
          .map { |row| row_text(row, shared) }
          .reject(&:empty?)
          .join("\n")
    end

    # @param row [Nokogiri::XML::Node]
    # @param shared [Array<String>]
    # @return [String] one row as tab-separated cell values
    def row_text(row, shared)
      values = []
      next_index = 0

      row.xpath("./c").each do |cell|
        index = column_index(cell["r"]) || next_index
        next_index = index + 1
        next if index >= MAX_COLUMNS

        values.concat([""] * (index - values.length)) if index > values.length
        values[index] = cell_text(cell, shared)
      end

      values.pop while !values.empty? && values.last.blank?
      values.join("\t")
    end

    # @param cell [Nokogiri::XML::Node]
    # @param shared [Array<String>]
    # @return [String]
    def cell_text(cell, shared)
      value = cell.at_xpath("./v")&.text
      text =
        case cell["t"]
        when "s"         then (shared[value.to_i] if value.present?)
        when "inlineStr" then string_item_text(cell.at_xpath("./is"))
        when "b"         then boolean_text(value)
        when "str", "e"  then value
        else value.presence || formula_text(cell)
        end
      normalize(text)
    end

    # @return [String, nil]
    def boolean_text(value)
      return nil if value.blank?

      value.to_s == "1" ? "TRUE" : "FALSE"
    end

    # @return [String, nil]
    def formula_text(cell)
      formula = cell.at_xpath("./f")&.text
      formula.present? ? "=#{formula}" : nil
    end

    # Text of a string item (`<si>`/`<is>`): the direct `<t>` runs, or rich-text
    # `<r><t>` runs when the item is formatted.
    #
    # @param node [Nokogiri::XML::Node, nil]
    # @return [String, nil]
    def string_item_text(node)
      return nil if node.nil?

      direct = node.xpath("./t").map(&:text).join
      return direct if direct.present?

      node.xpath("./r/t").map(&:text).join
    end

    # Convert an A1-style cell reference (e.g. "AB12") to a zero-based column
    # index, or nil when it carries no column letters.
    #
    # @param reference [String, nil]
    # @return [Integer, nil]
    def column_index(reference)
      letters = reference.to_s[/\A[A-Z]+/i]
      return nil if letters.nil?

      letters.upcase.each_byte.reduce(0) { |acc, byte| (acc * 26) + (byte - "A".ord + 1) } - 1
    end

    # ── Normalization ──────────────────────────────────────────────────

    # @param text [String, nil]
    # @return [String] inline whitespace collapsed
    def normalize(text)
      force_utf8(text).gsub("\u00A0", " ").gsub(/[ \t\r\n]+/, " ").strip
    end

    # @param text [String]
    # @return [String]
    def truncate(text)
      return text if text.length <= MAX_TEXT_CHARS

      "#{text[0, MAX_TEXT_CHARS]}\n\n[Content truncated — document exceeds #{MAX_TEXT_CHARS} characters.]"
    end

    # @param text [String, nil]
    # @return [String] valid UTF-8, invalid bytes dropped
    def force_utf8(text)
      text.to_s.encode("UTF-8", invalid: :replace, undef: :replace, replace: "")
    end
  end
end
