import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DesignToggle } from '../components/DesignToggle';
import { DESIGN_STORAGE_KEY, initialDesign, useDesignStore } from './design';

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-design');
  act(() => useDesignStore.setState({ design: 'classic' }));
});

describe('design switch (A11)', () => {
  it('starts on the current design and flips <html data-design> with the button', () => {
    render(<DesignToggle />);
    expect(document.documentElement).not.toHaveAttribute('data-design');
    fireEvent.click(screen.getByRole('button', { name: /التبديل إلى التصميم الجديد/ }));
    expect(document.documentElement).toHaveAttribute('data-design', 'figma');
    expect(window.localStorage.getItem(DESIGN_STORAGE_KEY)).toBe('figma');
    fireEvent.click(screen.getByRole('button', { name: /العودة إلى التصميم الحالي/ }));
    expect(document.documentElement).not.toHaveAttribute('data-design');
  });

  it('lets ?design= force a design and remembers it', () => {
    expect(initialDesign('?design=figma')).toBe('figma');
    expect(initialDesign('')).toBe('figma');
    expect(initialDesign('?design=classic')).toBe('classic');
    expect(initialDesign('')).toBe('classic');
  });
});
