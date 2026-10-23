# Native Git operation client

`@slop-lab/dim-service-client-native-git` is a shared caller-side library, consumed
by host plugins, Web plugins or trusted services. It does not register a plugin
or deploy the remote service.

`@slop-lab/dim-service-client-native-git` owns review evidence decoding, role attestation, bounded Git HTTP calls, sync results and shared CLI/Web operations. It depends on the operation and Git contracts, without a host, Web runtime or control-plane implementation.

`createNativeGitOperator({ reviewerConnection, promoterConnection?, syncConnection?, projects, selectedService? })` loads private role files, attests the reviewer and optional promoter/sync roles and returns `{ operations, invoke }`. Each invocation validates its input and output and reads the dynamic project catalog before accessing a repository. `projects.list` returns `{ reviewerId, projects: [{ projectId, name, repositoryIds }] }`; all review/sync operations require explicit `projectId` and `repositoryId`. Optional roles remove unavailable mutation operations from the catalog.

The host bridge passes its selected service endpoint, generation and host ID through `selectedService`; sibling role files must match those identities. Connection files must be absolute, owned mode-0600 regular files. Credentials remain on the trusted caller, never in operation descriptions, project lists or browser state. Review approval still names immutable review evidence; promotion remains separate host authority.

`nativeGitManagementOperations` is a separate controller capability catalog: `projects.create` and `repositories.import` are implemented by the host plugin, never by a direct human-reviewer service connection. Import inputs contain only project/repository IDs, a public HTTPS URL and optional branch. Controller-local registrar/importer authority and immutable bootstrap artifacts handle the operation; browser input cannot supply paths, credentials or repository policy.
