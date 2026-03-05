# bcf-viewer

Binary VCF viewer with variant type classification, header metadata, and genotype field parsing.

## Features

- BCF2 binary format parsing with BGZF decompression via pako.js
- VCF header metadata display (INFO, FORMAT, FILTER, contig definitions)
- Variant type classification (SNP, INDEL, MNP, etc.)
- Chromosome and position display
- REF/ALT allele coloring
- QUAL score display
- Collapsible header section
- Pagination (100 variants per page, first 2000 variants max)

## Supported Extensions

- `.bcf`

## Installation

Install from the **Plugins** tab in the AutoPipe desktop app.
