// SVG → 透明背景 PNG(ImageIO/CoreSVG 渲染,替代会填白底的 qlmanage)
// 用法: swift scripts/render-icon.swift <in.svg> <out.png> <size>
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let size = Int(args[3]) else {
    fputs("usage: render-icon.swift <in.svg> <out.png> <size>\n", stderr)
    exit(1)
}
guard let img = NSImage(contentsOfFile: args[1]) else {
    fputs("error: cannot load \(args[1])\n", stderr)
    exit(2)
}
guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { exit(3) }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high
img.draw(in: NSRect(x: 0, y: 0, width: size, height: size),
         from: .zero, operation: .copy, fraction: 1.0)
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(4) }
try! png.write(to: URL(fileURLWithPath: args[2]))
