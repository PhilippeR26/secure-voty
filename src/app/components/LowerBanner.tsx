"use client";
import { LuSquareArrowOutUpRight } from "react-icons/lu";
import { Box, Link } from "@chakra-ui/react";
import { proverInstallGuideUrl } from "../constants";

// Links open in a new tab: leaving the page would lose the login of the voter.
export default function LowerBanner() {
  return (
    <>
      {/* keeps the end of the page visible above the fixed banner */}
      <Box h="12" />
      <Box
        position={"fixed"}
        bottom="0%"
        width="100%"
        marginTop="1"
        borderColor="black"
        borderWidth="0px"
        borderRadius="0"
        bg='grey'
        opacity="95%"
        p="2"
        textAlign={'center'}
        fontSize="16"
        fontWeight="extrabold"
        color="gray.800"
      >
        <Link color="blue.700" href='https://github.com/PhilippeR26/secure-voty' target="_blank" rel="noreferrer"> Repo<LuSquareArrowOutUpRight /></Link>
        {" "}- {" "}
        <Link color="blue.700" href={proverInstallGuideUrl} target="_blank" rel="noreferrer"> Install your own SNIP-36 proof server<LuSquareArrowOutUpRight /></Link>
        {" "}- Powered by {" "}
        <Link color="blue.700" href='https://starknet-js.com' target="_blank" rel="noreferrer"> Starknet.js v11.3.0<LuSquareArrowOutUpRight /></Link>
      </Box>
    </>
  )
}
