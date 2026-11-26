import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mediaWidth } from '../test/viewport';
import { PHONE_BELOW_PX, useFullScreenDialog, usePhone } from './use-phone';

describe('usePhone', () => {
  describe('at 375 px', () => {
    mediaWidth(375);
    it('is true', () => expect(renderHook(() => usePhone()).result.current).toBe(true));
  });
  describe('one px below the phone width', () => {
    mediaWidth(PHONE_BELOW_PX - 1);
    it('is true', () => expect(renderHook(() => usePhone()).result.current).toBe(true));
  });
  describe('at the phone width', () => {
    mediaWidth(PHONE_BELOW_PX);
    it('is false', () => expect(renderHook(() => usePhone()).result.current).toBe(false));
  });
  describe('at 1280 px', () => {
    mediaWidth(1280);
    it('is false', () => expect(renderHook(() => usePhone()).result.current).toBe(false));
  });
  describe('with no width set', () => {
    it('is false', () => expect(renderHook(() => usePhone()).result.current).toBe(false));
  });
});

describe('useFullScreenDialog', () => {
  describe('at 375 px', () => {
    mediaWidth(375);
    it('is true', () => expect(renderHook(() => useFullScreenDialog()).result.current).toBe(true));
  });
  describe('at 600 px', () => {
    mediaWidth(600);
    it('is false', () => expect(renderHook(() => useFullScreenDialog()).result.current).toBe(false));
  });
  describe('at 1280 px', () => {
    mediaWidth(1280);
    it('is false', () => expect(renderHook(() => useFullScreenDialog()).result.current).toBe(false));
  });
});
