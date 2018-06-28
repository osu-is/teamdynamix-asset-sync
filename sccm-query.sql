Select   
-- Top-level attributes on the system 
rs.ResourceID as 'ResourceID', 
rs.Active0 as 'Active',
sysoun.System_OU_Name0 as 'OU_Name',
rs.Creation_Date0 as 'Creation_Date',
rs.Name0 as 'Name',
rs.Netbios_Name0 as 'Netbios_Name',

-- Enclosure attributes
bios.SerialNumber0 as 'SerialNumber',

-- Computer system attributes
compsys.Manufacturer0 as 'ComputerSystem-Manufacturer',
compsys.Model0 as 'ComputerSystem-Model',

-- OS Attributes
opsys.Caption0 as 'OS-Caption',
opsys.Version0 as 'OS-Version',

-- Hardware attributes
cpu.Name0 as 'CPU-Name',
mem.MemoryInstalled as 'Memory-Installed',

-- Primary User
usr.UniqueUserName as 'Primary-Username'

Into
#ComputerSystems
From
[CM_OCM].[dbo].[v_R_System] rs
Left Outer Join [CM_OCM].[dbo].v_GS_PC_BIOS bios on rs.ResourceID = bios.ResourceID
Left Outer Join [CM_OCM].[dbo].v_GS_COMPUTER_SYSTEM compsys On rs.ResourceID = compsys.ResourceID
Left Outer Join [CM_OCM].[dbo].v_GS_OPERATING_SYSTEM opsys On rs.ResourceID = opsys.ResourceID
Left Outer Join [CM_OCM].[dbo].v_GS_SYSTEM_ENCLOSURE_UNIQUE encl On rs.ResourceID = encl.ResourceID
Left Outer Join (
  Select Distinct cpu.ResourceID, cpu.Name0
  From [CM_OCM].[dbo].v_GS_PROCESSOR cpu
) cpu On rs.ResourceID = cpu.ResourceID
Left Outer Join (
  Select RSystem.ResourceID as ResourceID, SUM(PhyMem.Capacity0) As 'MemoryInstalled'
  From [CM_OCM].[dbo].v_R_System As RSystem
  Inner Join [CM_OCM].[dbo].v_GS_PHYSICAL_MEMORY As PhyMem on PhyMem.ResourceID = RSystem.ResourceID
  Group By RSystem.ResourceID
) mem On rs.ResourceID = mem.ResourceID
Left Outer Join (
	Select UniqueUserName, MachineResourceID
	From [CM_OCM].[dbo].[v_UserMachineRelation]
		Inner Join (
			Select MachineResourceID as MachineID,
					UniqueUserName as UserName
			From CM_OCM.dbo.v_UserMachineIntelligence
		) umi on umi.MachineID = MachineResourceID and umi.UserName = UniqueUserName
	Where MachineResourceID Not In
		(Select MachineResourceID
		From [CM_OCM].[dbo].[v_UserMachineRelation]
			Inner Join (
			Select MachineResourceID as MachineID,
					UniqueUserName as UserName
			From CM_OCM.dbo.v_UserMachineIntelligence
			) umi on umi.MachineID = MachineResourceID and umi.UserName = UniqueUserName
		Where RelationActive = 1
			And UniqueUserName Not Like 'font driver host%'
			And UniqueUserName Not Like '%\local_users'
		Group By MachineResourceID Having Count(*) > 1)
	And RelationActive = 1
	And UniqueUserName Not Like 'font driver host%'
	And UniqueUserName Not Like '%\local_users'
) As usr On usr.MachineResourceID = rs.ResourceID
Inner Join (
	Select *
	From [CM_OCM].[dbo]._RES_COLL_OCM0000A /* Client Services - All Desktop Clients */
	Union All
	Select *
	From [CM_OCM].[dbo]._RES_COLL_OCM001C2 /* Campus Labs - All Systems */
	Union All
	Select *
	From [CM_OCM].[dbo]._RES_COLL_OCM00021 /* CAS - All Desktop Clients */
	) coll On rs.ResourceID = coll.MachineID
Outer Apply (
  /* Get the most-specific OU name, hence the length ordering involved */
  Select
    Top(1)
    oun.System_OU_Name0
  From
    [CM_OCM].[dbo].v_RA_System_SystemOUName oun
  Where
    oun.ResourceID = rs.ResourceID
  Order By
    LEN(oun.System_OU_Name0) DESC
) sysoun

/* Get back network adapters for each system above that was retrieved */
Select
  -- Network adapter options
  na.MACAddress0 as 'MACAddress',
  na.Name0 as 'Name',
  na.ServiceName0 as 'ServiceName',

  -- Configuration options
  nac.DefaultIPGateway0 as 'DefaultIPGateway',
  nac.DHCPEnabled0 as 'DHCPEnabled',
  nac.DHCPServer0 as 'DHCPServer',
  nac.DNSDomain0 as 'DNSDomain',
  nac.DNSHostName0 as 'DNSHostName',
  nac.IPAddress0 as 'IPAddress',
  nac.IPSubnet0 as 'IPSubnet',

  -- This is used to link back to the associated network device, and also flatten
  -- out the order to get some hierarchy
  na.ResourceID,
  ROW_NUMBER() OVER (PARTITION BY na.ResourceID ORDER BY na.Description0) as ResourceIndex
Into
  #NetworkAdapters
From
  [CM_OCM].[dbo].v_GS_NETWORK_ADAPTER na
  Inner Join [CM_OCM].[dbo].v_GS_NETWORK_ADAPTER_CONFIGUR nac On na.ResourceID = nac.ResourceID
    And na.DeviceID0 = nac.Index0
  Inner Join #ComputerSystems cs On na.ResourceID = cs.[ResourceID]
Where
  /* This is a fairly-standard set of filtering parameters used to weed out unnecessary items such as loopback adapters. */
  na.AdapterType0 = 'Ethernet 802.3'
  And na.Description0 Not Like '%Miniport%'
  And Not (na.name0 Like '%Virtual%'
    And na.name0 Not Like '%Hyper-V%'
  )
  And na.Description0 Not Like '%VPN%'
  And na.Description0 Not Like '%Printer%'
  And na.Description0 Not Like '%vmxnet%'
  And na.Description0 Not Like '%Loopback%'
  And na.Description0 Not Like '%Bluetooth%'
  And na.Description0 Not Like '%TAP%'
  And na.MACAddress0 Is Not Null
Order By
  /* Order by description so they don't randomly reorder */
  na.Description0

/* Now select back all of the base computer information and a flattened-out version of the network adapter information */
Select
  cs.*, 

  -- Network adapter/configuration information
  na_1.[Name]as'NetworkAdapter0-Name',
  na_1.[MACAddress]as'NetworkAdapter0-MACAddress',

  na_2.[Name]as'NetworkAdapter1-Name',
  na_2.[MACAddress]as'NetworkAdapter1-MACAddress'
From
  #ComputerSystems cs
  /* Filter on ResourceIndex here to flatten out the hierarchy and prevent multiple rows from being returned. */
  Left Outer Join #NetworkAdapters na_1 On cs.ResourceID = na_1.ResourceID
    And na_1.ResourceIndex = 1
  Left Outer Join #NetworkAdapters na_2 On cs.ResourceID = na_2.ResourceID
    And na_2.ResourceIndex = 2