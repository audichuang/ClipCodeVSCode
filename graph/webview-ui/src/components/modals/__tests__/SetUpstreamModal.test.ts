import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import SetUpstreamModal from '../SetUpstreamModal.svelte';
import { branchStore } from '../../../lib/stores/branches.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { BranchInfo, RemoteInfo, BranchData } from '../../../lib/types';

function setRemoteState(remotes: RemoteInfo[], remoteBranches: BranchInfo[] = []) {
  const data: BranchData = {
    branches: remoteBranches,
    tags: [], remotes, stashes: [], worktrees: [],
  };
  branchStore.setData(data);
}

function remoteBranch(remote: string, name: string): BranchInfo {
  return { name: `${remote}/${name}`, current: false, remote, hash: 'abc', ahead: 0, behind: 0 };
}

beforeEach(() => {
  i18n.setLocale('en');
  setRemoteState([]);
});

describe('SetUpstreamModal', () => {
  it('parses an existing upstream "origin/main" into remote + branch parts', async () => {
    setRemoteState(
      [{ name: 'origin', fetchUrl: '', pushUrl: '' }],
      [remoteBranch('origin', 'main')],
    );
    const onSet = vi.fn();
    const { container } = render(SetUpstreamModal, {
      branchName: 'main',
      currentUpstream: 'origin/main',
      onClose: vi.fn(),
      onSet,
    });

    // Confirm immediately: parse should have prefilled remote=origin, branch=main.
    const submit = container.querySelector<HTMLButtonElement>('button.primary')!;
    await fireEvent.click(submit);

    expect(onSet).toHaveBeenCalledWith('origin', 'main', false);
  });

  it('keeps the trailing path in the branch when upstream has nested slashes', async () => {
    setRemoteState(
      [{ name: 'origin', fetchUrl: '', pushUrl: '' }],
      // No matching remote branch — exercises the "manual input" path through
      // the modal so we can read back what `parseUpstream` produced.
      [],
    );
    const onSet = vi.fn();
    const { container } = render(SetUpstreamModal, {
      branchName: 'feature',
      currentUpstream: 'origin/feature/login',
      onClose: vi.fn(),
      onSet,
    });
    const submit = container.querySelector<HTMLButtonElement>('button.primary')!;
    await fireEvent.click(submit);

    // 3rd arg = createRemote: true since this remote branch doesn't exist yet.
    expect(onSet).toHaveBeenCalledWith('origin', 'feature/login', true);
  });

  it('treats upstream with no slash as bare branch name + empty remote', async () => {
    setRemoteState([{ name: 'origin', fetchUrl: '', pushUrl: '' }]);
    const onSet = vi.fn();
    const { container } = render(SetUpstreamModal, {
      branchName: 'main',
      currentUpstream: 'standalone',
      onClose: vi.fn(),
      onSet,
    });
    const submit = container.querySelector<HTMLButtonElement>('button.primary')!;
    await fireEvent.click(submit);

    // parseUpstream returns { remote: '', branch: 'standalone' }, then the
    // selectedRemote $state initializer falls back to remoteNames[0] = 'origin'.
    expect(onSet).toHaveBeenCalledWith('origin', 'standalone', true);
  });

  it('passes createRemote=false when the remote branch already exists locally', async () => {
    setRemoteState(
      [{ name: 'origin', fetchUrl: '', pushUrl: '' }],
      [remoteBranch('origin', 'main')],
    );
    const onSet = vi.fn();
    const { container } = render(SetUpstreamModal, {
      branchName: 'main',
      currentUpstream: 'origin/main',
      onClose: vi.fn(),
      onSet,
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onSet).toHaveBeenCalledWith('origin', 'main', false);
  });

  it('renders remote picker only when more than one remote exists', () => {
    // single remote → no picker
    setRemoteState([{ name: 'origin', fetchUrl: '', pushUrl: '' }]);
    const single = render(SetUpstreamModal, {
      branchName: 'main',
      currentUpstream: '',
      onClose: vi.fn(),
      onSet: vi.fn(),
    });
    expect(single.container.querySelectorAll('.color-select').length).toBe(0);
    single.unmount();

    // two remotes → picker appears
    setRemoteState([
      { name: 'origin', fetchUrl: '', pushUrl: '' },
      { name: 'upstream', fetchUrl: '', pushUrl: '' },
    ]);
    const multi = render(SetUpstreamModal, {
      branchName: 'main',
      currentUpstream: '',
      onClose: vi.fn(),
      onSet: vi.fn(),
    });
    expect(multi.container.querySelectorAll('.color-select').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the "will create new" notice when the chosen branch is not on the remote', async () => {
    setRemoteState(
      [{ name: 'origin', fetchUrl: '', pushUrl: '' }],
      [remoteBranch('origin', 'main')],
    );
    const { container } = render(SetUpstreamModal, {
      branchName: 'wip',
      currentUpstream: '',
      onClose: vi.fn(),
      onSet: vi.fn(),
    });
    // No upstream + branch name "wip" doesn't exist on origin → notice shown.
    const notice = container.querySelector('.notice');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('git push -u');
  });

  it('toggle to manual input mode then back, then submit uses textBranch', async () => {
    setRemoteState(
      [{ name: 'origin', fetchUrl: '', pushUrl: '' }],
      [remoteBranch('origin', 'main')],
    );
    const onSet = vi.fn();
    const { container } = render(SetUpstreamModal, {
      branchName: 'main',
      currentUpstream: 'origin/main',
      onClose: vi.fn(),
      onSet,
    });
    // hasBranchOptions=true (origin/main exists) and currentUpstream truthy
    // → manualInput starts false (useDropdown=true). Click the toggle to flip
    // to manual input, then back to dropdown.
    const toggle = container.querySelector<HTMLButtonElement>('.toggle-btn')!;
    expect(toggle).not.toBeNull();
    await fireEvent.click(toggle);
    // Now in manual input mode — there's an <input>, no ColorSelect for branch
    const input = container.querySelector<HTMLInputElement>('input.modal-input')!;
    expect(input).not.toBeNull();
    await fireEvent.input(input, { target: { value: 'custom-branch' } });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    // remote branch doesn't exist on remote → createRemote=true
    expect(onSet).toHaveBeenCalledWith('origin', 'custom-branch', true);
  });

  it('switching remote via the picker re-derives the branch options', async () => {
    setRemoteState(
      [
        { name: 'origin', fetchUrl: '', pushUrl: '' },
        { name: 'fork', fetchUrl: '', pushUrl: '' },
      ],
      [
        remoteBranch('origin', 'main'),
        remoteBranch('fork', 'experiment'),
      ],
    );
    const onSet = vi.fn();
    const { container } = render(SetUpstreamModal, {
      branchName: 'main',
      currentUpstream: 'origin/main',
      onClose: vi.fn(),
      onSet,
    });
    // Two .color-select instances: [remote picker, branch picker].
    const selects = container.querySelectorAll<HTMLButtonElement>('.color-select-btn');
    // Open the remote picker (first) and switch to "fork".
    await fireEvent.click(selects[0]);
    const opts = container.querySelectorAll<HTMLButtonElement>('.color-select-option');
    const forkOpt = Array.from(opts).find(o => o.textContent?.includes('fork'))!;
    await fireEvent.click(forkOpt);
    // Branch picker now should show "fork/experiment" as the available option.
    // Open it and confirm.
    const selects2 = container.querySelectorAll<HTMLButtonElement>('.color-select-btn');
    await fireEvent.click(selects2[1]);
    const branchOpts = container.querySelectorAll<HTMLButtonElement>('.color-select-option');
    const experiment = Array.from(branchOpts).find(o => o.textContent?.includes('experiment'));
    expect(experiment).not.toBeUndefined();
    await fireEvent.click(experiment!);
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    expect(onSet).toHaveBeenCalledWith('fork', 'experiment', false);
  });

  it('submit is disabled when the active branch is blank', async () => {
    setRemoteState([{ name: 'origin', fetchUrl: '', pushUrl: '' }]);
    const { container } = render(SetUpstreamModal, {
      branchName: '', // initial branchName triggers default activeBranch=''
      currentUpstream: '',
      onClose: vi.fn(),
      onSet: vi.fn(),
    });
    const submit = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(submit.disabled).toBe(true);
  });
});
