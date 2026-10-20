/**
 * The scan code the GUI card draws.
 *
 * There is no page of our own any more: the settings card fetches the markup from
 * `/dsh-wechat/api/qr` and renders it inline, and headless profiles print the code in the
 * terminal instead. This object only holds what the card and the login flow share:
 * the current phase, the payload being shown, and the derived SVG.
 *
 * @module dsh-wechat/qrstate
 */

import { encodeQrMatrix, renderQrSvg } from './qr.js'

/** Rendered page states. */
const PHASES = {
  idle: '尚未开始登录',
  waiting: '等待扫码',
  scaned: '已扫码，请在手机上确认',
  confirmed: '登录成功',
  expired: '二维码已过期，正在重新申请',
  failed: '登录失败',
}

/** @returns {string} the human label of a phase. */
export function phaseLabel(phase) {
  return PHASES[phase] ?? phase
}

export class QrState {
  constructor() {
    /** Latest login state pushed by the channel. */
    this.state = { phase: 'idle', payload: null, qrcode: null, detail: null }
    /** Extra context the card displays (bot id, pending sign-in, …). */
    this.status = () => ({})
    /** Set when the operator asks for a fresh code so the channel can restart the flow. */
    this.restartRequested = false
  }

  /**
   * @returns {{ phase: string, label: string, detail: string|null, hasQr: boolean }} the
   *   machine-readable state (never includes the bot token).
   */
  snapshot() {
    const extra = typeof this.status === 'function' ? this.status() : {}
    const phase = extra.loggedIn ? 'confirmed' : this.state.phase
    return {
      phase,
      label: phaseLabel(phase),
      detail: this.state.detail ?? null,
      hasQr: Boolean(this.state.payload && !extra.loggedIn),
      ...extra,
    }
  }

  /**
   * The code currently shown, as a standalone SVG document.
   * @returns {string|null} the SVG, or null when there is no code to scan.
   */
  qrSvg() {
    if (!this.state.payload) return null
    return renderQrSvg(encodeQrMatrix(this.state.payload), { scale: 6, quietZone: 4 })
  }

  /**
   * A short marker that changes whenever the code changes, for cache busting.
   * @returns {string|null} an opaque version string, or null without a code.
   */
  get qrVersion() {
    if (!this.state.payload) return null
    let hash = 0
    const text = String(this.state.payload)
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) | 0
    }
    return Math.abs(hash).toString(36)
  }

  /**
   * Publish a new code (or clear it with `payload: null`).
   * @param {{ phase?: string, payload?: string|null, qrcode?: string|null, detail?: string|null }} next - login state.
   * @returns {void}
   */
  publish(next) {
    this.state = {
      phase: next.phase ?? this.state.phase,
      payload: next.payload === undefined ? this.state.payload : next.payload,
      qrcode: next.qrcode === undefined ? this.state.qrcode : next.qrcode,
      detail: next.detail === undefined ? this.state.detail : next.detail,
    }
  }
}
