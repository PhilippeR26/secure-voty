"use client";

import { useForm } from "react-hook-form";
import { useStoreChoice } from "./contextChoice";
import { Button, Center, Field, Input, Text } from "@chakra-ui/react";
import { useState } from "react";
import { checkSecret, checkWhitelist } from "../server/voterProofs";
import { CairoBytes31 } from "starknet";

interface FormValues {
  emailValue: string,
  secretValue: number,
}
export default function Email() {
  const [isWhiteListed, setIsWhiteListed] = useState<boolean | null>(null);
  const { email, setEmail, userAuthorized, setUserAuthorized, setSecret } = useStoreChoice();

  const {
    handleSubmit,
    register,
    formState: { errors, isSubmitting, isValid }
  } = useForm<FormValues>();

  async function onSubmitResponse(values: FormValues) {
    setIsWhiteListed(false);
    setUserAuthorized(false)
    const proof = await checkWhitelist(new CairoBytes31(values.emailValue).toHexString(), process.env.NEXT_PUBLIC_API_KEY!);
    const secretIsValid = await checkSecret(new CairoBytes31(values.emailValue).toHexString(), values.secretValue.toString(), process.env.NEXT_PUBLIC_API_KEY!);

    // if result is Error, the following code is not executed.
    if (proof.isWhiteListed) {
      setIsWhiteListed(true);
      setEmail(values.emailValue);
      if (secretIsValid) {
        setSecret(values.secretValue.toString());
        setUserAuthorized(true);
      }
    }
  }


  return (
    <>
      {!userAuthorized ? (
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
              <Field.Root invalid={!!errors.secretValue} mt={3}>
                <Field.Label htmlFor="encoded"> The 8 digit secret you received by email :</Field.Label>
                <Input
                  w="100%" minH={50} maxH={500}
                  bg="gray.800"
                  color="blue.200"
                  defaultValue={email}
                  id="encoded"
                  {...register("secretValue", {
                    required: "This is required. Ex: 12345678",
                    pattern: {
                      value: /^\d{8}$/,
                      message: "Must be exactly 8 digits"
                    }
                  })}
                />
                <Field.ErrorText color={"darkred"}>
                  {errors.secretValue && errors.secretValue.message}
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
            {isWhiteListed !== null && (isWhiteListed === false ? "Sorry, you are not in the list of valid voters." : "Sorry, your secret is not valid.")}
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
