// Seed tag list for the "Tristar" device, copied by hand from what
// Data > Explore shows on screen in Corvina, because a confirmed API
// endpoint that lists every tag for a device hasn't been found yet
// (see the note in corvinaClient.js). Once that endpoint is confirmed,
// this file goes away and listDevices()/listTags() takes over completely.
//
// Add more rows here as you scroll further down that Explore list --
// this is only the portion visible so far.

module.exports = {
  Tristar: [
    "Application/DCDC/DC1301_st_dcu_p",
    "Application/DCDC/DC1301_st_sys_temp_junc_max",
    "Application/DCDC/DC1302_st_dcu_p",
    "Application/DCDC/DC1302_st_sys_temp_junc_max",
    "Application/DCDC/DC2301_st_dcu_p",
    "Application/DCDC/DC2301_st_sys_temp_junc_max",
    "Application/DCDC/DC2302_st_dcu_p",
    "Application/DCDC/DC2302_st_sys_temp_junc_max",
    "Application/DG/DG140n_st_sys_temp_ext_1",
    "Application/DG/DG140n_st_sys_temp_ext_2",
    "Application/DG/DG140n_st_sys_temp_ext_3",
    "Application/DG/DG240n_st_sys_temp_ext_1",
    "Application/DG/DG240n_st_sys_temp_ext_2",
    "Application/DG/DG240n_st_sys_temp_ext_3",
    "Application/DG/DG1401_st_mot_p_axis",
    "Application/DG/DG1401_st_sys_temp_junc_max",
    "Application/DG/DG1402_st_mot_p_axis",
    "Application/DG/DG1402_st_sys_temp_junc_max",
  ],
};
