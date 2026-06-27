import { registerContainerProfileListCommand } from './profile-list.js';
import { registerContainerProfileShowCommand } from './profile-show.js';
import { registerContainerProfileApplyCommand } from './container-profile-apply.js';
import { registerContainerProfileDeleteCommand } from './container-profile-delete.js';

export function registerContainerProfileCommands(
  program: import('commander').Command,
): void {
  const group = program
    .command('container-profile')
    .description('Manage container profiles');

  registerContainerProfileListCommand(group);
  registerContainerProfileShowCommand(group);
  registerContainerProfileApplyCommand(group);
  registerContainerProfileDeleteCommand(group);
}
