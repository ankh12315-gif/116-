from pathlib import Path
p=Path('src/scene/RoomGeometry.tsx')
s=p.read_text(encoding='utf-8').replace("      <span data-solids={solidGeom.length} style={{ display: 'none' }} />",'')
p.write_text(s,encoding='utf-8')
p=Path('src/__tests__/coords.test.ts')
s=p.read_text(encoding='utf-8').replace('quantization: SPAN_Q,',"quantization: {...SPAN_Q, scaleMode: 'SPAN'},").replace('quantization: PER_LSB_Q,',"quantization: {...PER_LSB_Q, scaleMode: 'PER_LSB'},")
p.write_text(s,encoding='utf-8')
