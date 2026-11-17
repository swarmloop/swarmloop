import { useState, type ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from '../../lib/endpoints';
import { Composer } from './composer';

vi.mock('../../lib/endpoints', () => ({ uploadFile: vi.fn() }));

function Harness({ onSend }: { onSend: (text: string, ids: string[]) => void }): ReactElement {
  const [value, setValue] = useState('');
  return (
    <Composer
      value={value}
      onChange={setValue}
      hint="goes into the plan"
      onSend={(text, files) =>
        onSend(
          text,
          files.map((file) => file.id),
        )
      }
      label="Message"
      sendLabel="Send"
    />
  );
}

const picture = (name = 'shot.png'): File => new File(['abc'], name, { type: 'image/png' });

beforeEach(() => {
  vi.mocked(uploadFile).mockReset();
  vi.mocked(uploadFile).mockImplementation((_file, name) => Promise.resolve({ id: `id-${name}`, name, size: 3 }));
});

describe('Composer', () => {
  it('is labelled, shows the hint and takes several lines', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness onSend={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Message' });

    await user.type(box, 'one{Enter}two');

    expect(box).toHaveValue('one\ntwo');
    expect(screen.getByText('goes into the plan')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeVisible();
  });

  it('sends with Ctrl+Enter and with Cmd+Enter, and not with a bare Enter', async () => {
    const user = userEvent.setup({ delay: null });
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello');

    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('hello\n', []);
  });

  it('keeps Send disabled while the box is empty and is reachable by keyboard', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness onSend={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Attach files' })).toHaveFocus();
  });

  it('shows a dropped file as a chip, sends its id, and drops it when removed', async () => {
    const user = userEvent.setup({ delay: null });
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'see');

    fireEvent.drop(screen.getByRole('textbox', { name: 'Message' }), { dataTransfer: { files: [picture('a.txt')] } });
    expect(await screen.findByText('a.txt')).toBeVisible();
    fireEvent.drop(screen.getByRole('textbox', { name: 'Message' }), { dataTransfer: { files: [picture('b.txt')] } });
    await screen.findByText('b.txt');
    await user.click(screen.getByRole('img', { name: 'Remove a.txt' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.queryByText('a.txt')).toBeNull();
    expect(onSend).toHaveBeenCalledWith('see', ['id-b.txt']);
  });

  it('takes a pasted image as a chip and leaves pasted text to the field', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness onSend={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Message' });

    await user.click(box);
    await user.paste('plain words');
    expect(box).toHaveValue('plain words');
    expect(uploadFile).not.toHaveBeenCalled();

    fireEvent.paste(box, { clipboardData: { files: [picture()] } });
    expect(await screen.findByText('shot.png')).toBeVisible();
    expect(box).toHaveValue('plain words');
  });

  it('picks files with the paperclip', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness onSend={vi.fn()} />);

    await user.upload(screen.getByTestId('composer-file-input'), [picture('x.png'), picture('y.png')]);

    expect(await screen.findByText('x.png')).toBeVisible();
    expect(await screen.findByText('y.png')).toBeVisible();
  });

  it('shows the server reason for a refused file and attaches nothing', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(uploadFile).mockRejectedValue(new Error('A file can be at most 25 MB'));
    render(<Harness onSend={vi.fn()} />);

    await user.upload(screen.getByTestId('composer-file-input'), picture('big.bin'));

    expect(await screen.findByRole('alert')).toHaveTextContent('A file can be at most 25 MB');
    await waitFor(() => expect(screen.queryByText('big.bin')).toBeNull());
  });
});
