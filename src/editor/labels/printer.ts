"use client";
/**
 * Talking to a Brother P-touch from the browser.
 *  - WebUSB (Chrome / Edge, desktop): the printer connected with its USB cable.
 *  - Web Serial (Chrome / Edge): Bluetooth models (PT-P710BT, PT-E560BT …) paired with the computer
 *    appear as a serial port.
 * Both send the raster byte stream from src/core/ptouch.ts; WebUSB can also read the printer status
 * (loaded tape width and type, errors).
 */
import { parseStatus, STATUS_REQUEST, type PtStatus } from "@/core/ptouch";

export const BROTHER_VENDOR = 0x04f9;

export interface PrinterLink {
  kind: "usb" | "serial";
  name: string;
  send(data: Uint8Array): Promise<void>;
  status(): Promise<PtStatus | null>;
  close(): Promise<void>;
}

type USBDeviceLike = {
  productName?: string;
  opened: boolean;
  configuration: { interfaces: { interfaceNumber: number; alternate: { interfaceClass: number; endpoints: { direction: "in" | "out"; type: string; endpointNumber: number }[] } }[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(ep: number, data: BufferSource): Promise<{ status: string }>;
  transferIn(ep: number, len: number): Promise<{ data?: DataView; status: string }>;
};
type NavUsb = { usb?: { requestDevice(o: { filters: { vendorId: number }[] }): Promise<USBDeviceLike>; getDevices(): Promise<USBDeviceLike[]> } };
type SerialPortLike = { open(o: { baudRate: number }): Promise<void>; close(): Promise<void>; writable: WritableStream<Uint8Array> | null; readable: ReadableStream<Uint8Array> | null; getInfo(): { usbVendorId?: number; bluetoothServiceClassId?: string } };
type NavSerial = { serial?: { requestPort(o?: object): Promise<SerialPortLike> } };

export const usbSupported = () => typeof navigator !== "undefined" && !!(navigator as unknown as NavUsb).usb;
export const serialSupported = () => typeof navigator !== "undefined" && !!(navigator as unknown as NavSerial).serial;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openUsb(dev: USBDeviceLike): Promise<PrinterLink> {
  if (!dev.opened) await dev.open();
  if (!dev.configuration) await dev.selectConfiguration(1);
  // the printer-class interface (7) with a bulk OUT endpoint
  const itf = dev.configuration!.interfaces.find((i) => i.alternate.endpoints.some((e) => e.direction === "out" && e.type === "bulk")) ?? dev.configuration!.interfaces[0];
  const out = itf.alternate.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
  const inn = itf.alternate.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
  if (!out) throw new Error("This USB device has no printer endpoint — is P-touch Editor Lite switched off?");
  try {
    await dev.claimInterface(itf.interfaceNumber);
  } catch {
    throw new Error("The printer is in use by the system driver. On Windows install the WinUSB driver for it (Zadig) or print the PDF instead; on Linux unload the usblp module.");
  }
  const link: PrinterLink = {
    kind: "usb",
    name: dev.productName || "Brother P-touch (USB)",
    async send(data) {
      const CH = 16 * 1024;
      for (let i = 0; i < data.length; i += CH) {
        const r = await dev.transferOut(out.endpointNumber, data.slice(i, i + CH));
        if (r.status !== "ok") throw new Error(`USB transfer failed (${r.status})`);
      }
    },
    async status() {
      if (!inn) return null;
      await link.send(STATUS_REQUEST);
      for (let k = 0; k < 10; k++) {
        const r = await dev.transferIn(inn.endpointNumber, 32);
        if (r.data && r.data.byteLength >= 32) return parseStatus(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        await sleep(100);
      }
      return null;
    },
    async close() {
      try {
        await dev.releaseInterface(itf.interfaceNumber);
      } catch {}
      await dev.close().catch(() => {});
    },
  };
  return link;
}

/** ask the user to choose the printer (needs a click) */
export async function connectUsb(): Promise<PrinterLink> {
  const usb = (navigator as unknown as NavUsb).usb;
  if (!usb) throw new Error("WebUSB is not available in this browser — use Chrome or Edge on a desktop, or download the PDF");
  const dev = await usb.requestDevice({ filters: [{ vendorId: BROTHER_VENDOR }] });
  return openUsb(dev);
}

/** a printer allowed earlier (no prompt) */
export async function reconnectUsb(): Promise<PrinterLink | null> {
  const usb = (navigator as unknown as NavUsb).usb;
  if (!usb) return null;
  const list = await usb.getDevices().catch(() => []);
  const dev = list.find(() => true);
  return dev ? openUsb(dev).catch(() => null) : null;
}

export async function connectSerial(): Promise<PrinterLink> {
  const serial = (navigator as unknown as NavSerial).serial;
  if (!serial) throw new Error("Web Serial is not available in this browser — use Chrome or Edge on a desktop");
  const port = await serial.requestPort();
  await port.open({ baudRate: 115200 });
  const link: PrinterLink = {
    kind: "serial",
    name: "Brother P-touch (Bluetooth / serial)",
    async send(data) {
      const w = port.writable!.getWriter();
      try {
        const CH = 4096;
        for (let i = 0; i < data.length; i += CH) await w.write(data.slice(i, i + CH));
      } finally {
        w.releaseLock();
      }
    },
    async status() {
      if (!port.readable) return null;
      await link.send(STATUS_REQUEST);
      const r = port.readable.getReader();
      const buf: number[] = [];
      const t = setTimeout(() => r.cancel().catch(() => {}), 1500);
      try {
        while (buf.length < 32) {
          const { value, done } = await r.read();
          if (done || !value) break;
          buf.push(...value);
        }
      } catch {
      } finally {
        clearTimeout(t);
        r.releaseLock();
      }
      return parseStatus(Uint8Array.from(buf.slice(-32)));
    },
    async close() {
      await port.close().catch(() => {});
    },
  };
  return link;
}
