import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SeriesChart } from './series';

describe('SeriesChart', () => {
  it('shows the last CPU value in the legend', () => {
    render(
      <SeriesChart
        samples={[
          { cpu: 12, memory: 1000 },
          { cpu: 42, memory: 2000 },
        ]}
      />,
    );

    expect(screen.getByText('CPU 42%')).toBeInTheDocument();
  });

  it('draws the chart with its accessible name', () => {
    render(<SeriesChart samples={[{ cpu: 12, memory: 1000 }]} />);

    expect(screen.getByRole('img', { name: 'CPU and memory' })).toBeInTheDocument();
  });
});
