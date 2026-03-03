"use client";

import { useForm } from "react-hook-form";
import { useStoreChoice } from "./contextChoice";
import { Button, Center, Field, Input, Text } from "@chakra-ui/react";
import { useState } from "react";
import { checkWhitelist } from "../server/voterProofs";
import { CairoBytes31 } from "starknet";

interface FormValues {
  emailValue: string,
}
export default function Email() {
  const [isWhiteListed, setIsWhiteListed] = useState<boolean | null>(null);
  const { email, setEmail, emailOK, setEmailOK } = useStoreChoice();

  const {
    handleSubmit,
    register,
    formState: { errors, isSubmitting, isValid }
  } = useForm<FormValues>();

  async function onSubmitResponse(values: FormValues) {
    const proof = await checkWhitelist(new CairoBytes31(values.emailValue).toHexString());
    if (proof.isWhiteListed) {
      // TODO: test if already voted
      setIsWhiteListed(true);
      setEmail(values.emailValue);
      setEmailOK(true);
      return;
    }
    setIsWhiteListed(false);
    return;
  }


  return (
    <>
      {!emailOK ? (
        <>
          <Center>
            <form onSubmit={handleSubmit(onSubmitResponse)}>
              <Field.Root invalid={!!errors.emailValue}>
                <Field.Label htmlFor="encoded"> Your email to vote :</Field.Label>
                <Input
                  w="100%" minH={50} maxH={500}
                  bg="gray.800"
                  color="blue.200"
                  defaultValue={email}
                  id="encoded"
                  {...register("emailValue", {
                    required: "This is required. Ex: nom@site.com", pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
                  })}
                />
                <Field.ErrorText color={"darkred"}>
                  {errors.emailValue && errors.emailValue.message}
                  {errors.emailValue && errors.emailValue.type == "pattern" && <span>Not a valid email address</span>}
                </Field.ErrorText>
              </Field.Root>
              <Center>
                <Button
                  colorPalette="blue"
                  mt={2}
                  loading={isSubmitting}
                  borderWidth={2}
                  borderColor={isValid ? "lightblue" : "red"}
                  type="submit"
                >OK</Button>
              </Center>
            </form>
          </Center>
          <Center color="red" fontSize="lg">
            {isWhiteListed === false && "Sorry, you are not in the list of valid voters."}
          </Center>
        </>
      ) : (
        <Center fontSize="xl" pt={4}>
          Your email:
          <Text fontWeight={600}>
            {email}

          </Text>
        </Center>
      )}
    </>
  )
}
