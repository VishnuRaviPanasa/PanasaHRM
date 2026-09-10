import { Module } from '@nestjs/common';
import { DbModule } from './db';
import { AuthModule } from './auth';
import { AuthzModule } from './authz';
import { StorageModule } from './storage';
import { DocumentsModule } from './documents';
import { ReportsModule } from './reports';
import { HrModule } from './hr';
import { LeaveModule } from './leave';
import { WorkModule } from './work';
import { SettingsModule } from './settings';
import { PayrollModule } from './payroll';
import { OrgModule } from './org';
import { PeopleModule } from './people';
import { WorkMastersModule } from './work-masters';
import { AssistantModule } from './assistant/assistant.controller';

@Module({
  imports: [
    DbModule, AuthModule, AuthzModule, StorageModule,
    DocumentsModule, ReportsModule, HrModule, LeaveModule, WorkModule, SettingsModule,
    PayrollModule, OrgModule, PeopleModule, WorkMastersModule,
    // ADR-0020. A LEAF: it reads through the other modules' actions and nothing depends on it,
    // so removing this line removes the feature and breaks nothing else.
    AssistantModule,
  ],
})
export class AppModule {}
