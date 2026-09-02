"use client";

import { useEffect, useRef } from "react";

type Candle = { open: number; close: number; high: number; low: number };

const CANDLE_W = 14;
const GAP = 8;

export default function ChartBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    let width = 0;
    let height = 0;
    let candles: Candle[] = [];
    let offset = 0;
    let rafId = 0;

    const clampPrice = (p: number) =>
      Math.max(height * 0.2, Math.min(height * 0.8, p));

    function nextCandle(prevClose: number): Candle {
      let base = prevClose + (Math.random() - 0.48) * 40;
      base = clampPrice(base);
      const open = base;
      const close = base + (Math.random() - 0.5) * 36;
      const high = Math.max(open, close) + Math.random() * 18;
      const low = Math.min(open, close) - Math.random() * 18;
      return { open, close, high, low };
    }

    function buildCandles() {
      candles = [];
      const count = Math.ceil(width / (CANDLE_W + GAP)) + 2;
      let price = height * 0.5;
      for (let i = 0; i < count; i++) {
        const c = nextCandle(price);
        candles.push(c);
        price = c.close;
      }
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildCandles();
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const x = i * (CANDLE_W + GAP) - offset;
        const up = c.close <= c.open; // lower y = higher price
        ctx!.strokeStyle = up
          ? "rgba(34, 211, 138, 0.55)"
          : "rgba(255, 93, 115, 0.55)";
        ctx!.fillStyle = up
          ? "rgba(34, 211, 138, 0.35)"
          : "rgba(255, 93, 115, 0.35)";

        // wick
        ctx!.beginPath();
        ctx!.moveTo(x + CANDLE_W / 2, c.high);
        ctx!.lineTo(x + CANDLE_W / 2, c.low);
        ctx!.stroke();

        // body
        const top = Math.min(c.open, c.close);
        const h = Math.max(2, Math.abs(c.close - c.open));
        ctx!.fillRect(x, top, CANDLE_W, h);
      }

      offset += 0.35;
      if (offset >= CANDLE_W + GAP) {
        offset -= CANDLE_W + GAP;
        candles.shift();
        const last = candles[candles.length - 1];
        candles.push(nextCandle(last ? last.close : height * 0.5));
      }

      rafId = requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener("resize", resize);

    if (reduceMotion) {
      draw();
      cancelAnimationFrame(rafId);
    } else {
      rafId = requestAnimationFrame(draw);
    }

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return <canvas ref={canvasRef} className="chart-bg" aria-hidden="true" />;
}
